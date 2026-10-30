const SERVER_URL = "http://127.0.0.1:8000";

let audioContext = null;
let audioBuffer = null;
let sourceNode = null;

// 音量ノード
let musicGainNode = null;
let clickGainNode = null;

let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;

let bpm = 120;
let offsetSec = 0;

// クリック音スケジュール用変数
let nextNoteTime = 0.0;
let currentBeat = 0;
let timerID = null;
let uiUpdateTimerID = null;
const scheduleAheadTime = 0.1; // 100ms先まで予約
const lookahead = 25.0;        // 25ms周期でチェック

window.addEventListener("DOMContentLoaded", () => {
  const youtubeUrlInput = document.getElementById("youtubeUrl");
  const loadYoutubeBtn = document.getElementById("loadYoutubeBtn");
  const localFileInput = document.getElementById("localFileInput");
  const statusText = document.getElementById("statusText");

  const bpmInput = document.getElementById("bpmInput");
  const offsetInput = document.getElementById("offsetInput");

  const musicVolInput = document.getElementById("musicVol");
  const clickVolInput = document.getElementById("clickVol");
  const seekSlider = document.getElementById("seekSlider");
  const currentTimeText = document.getElementById("currentTimeText");

  const playBtn = document.getElementById("playBtn");
  const stopBtn = document.getElementById("stopBtn");

  function setStatus(text, isError = false) {
    if (statusText) {
      statusText.textContent = text;
      statusText.style.color = isError ? "#d9534f" : "#28a745";
    }
    console.log(`[Status] ${text}`);
  }

  // Web Audio Context & Gain (音量) ノードの初期化
  function initAudioContext() {
    if (!audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContext();

      musicGainNode = audioContext.createGain();
      musicGainNode.gain.value = musicVolInput ? parseFloat(musicVolInput.value) : 0.8;
      musicGainNode.connect(audioContext.destination);

      clickGainNode = audioContext.createGain();
      clickGainNode.gain.value = clickVolInput ? parseFloat(clickVolInput.value) : 0.8;
      clickGainNode.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  }

  // クリック音の発音関数
  function scheduleClick(time, isAccent) {
    if (!audioContext || !clickGainNode) return;

    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();

    osc.frequency.value = isAccent ? 1200 : 800;

    env.gain.setValueAtTime(1, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.connect(env);
    env.connect(clickGainNode);

    osc.start(time);
    osc.stop(time + 0.05);
  }

  // 高精度タイマー（高音質スケジューラー）
  function scheduler() {
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
      scheduleClick(nextNoteTime, currentBeat === 0);
      
      const secondsPerBeat = 60.0 / bpm;
      nextNoteTime += secondsPerBeat;
      currentBeat = (currentBeat + 1) % 4;
    }
    timerID = window.setTimeout(scheduler, lookahead);
  }

  // 出だしと位置に合わせたクリックタイミングの正確な再計算
  function setupClickTiming(playbackPosition) {
    const secondsPerBeat = 60.0 / bpm;
    
    // 曲頭（offsetSec）からの経過時間
    let timeFromFirstBeat = playbackPosition - offsetSec;

    if (timeFromFirstBeat < 0) {
      // まだ第1拍目のオフセット秒数に到達していない場合
      currentBeat = 0;
      nextNoteTime = audioContext.currentTime + (-timeFromFirstBeat);
    } else {
      // 既に第1拍目を過ぎている場合
      const beatsPassed = Math.floor(timeFromFirstBeat / secondsPerBeat);
      currentBeat = beatsPassed % 4;
      const remainder = timeFromFirstBeat % secondsPerBeat;
      nextNoteTime = audioContext.currentTime + (secondsPerBeat - remainder);
    }
  }

  // UI上の時間スライダー更新関数
  function updateUI() {
    if (!isPlaying || !audioContext) return;
    const currentPos = audioContext.currentTime - startTime;
    if (seekSlider && audioBuffer) {
      seekSlider.value = Math.min(currentPos, audioBuffer.duration);
    }
    if (currentTimeText) {
      currentTimeText.textContent = `${currentPos.toFixed(1)}s`;
    }
    uiUpdateTimerID = requestAnimationFrame(updateUI);
  }

  // 1. YouTube 読み込み & 解析
  if (loadYoutubeBtn) {
    loadYoutubeBtn.addEventListener("click", async () => {
      const url = youtubeUrlInput ? youtubeUrlInput.value.trim() : "";
      if (!url) {
        alert("YouTubeのURLを入力してください");
        return;
      }

      initAudioContext();
      if (playBtn) playBtn.disabled = true;
      setStatus("1/2: 音声をダウンロード中... (数十秒かかります)");

      try {
        const audioRes = await fetch(`${SERVER_URL}/api/audio?url=${encodeURIComponent(url)}`);
        if (!audioRes.ok) throw new Error("音声の取得に失敗しました");

        const arrayBuffer = await audioRes.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        setStatus("2/2: AI解析中 (BPMと拍の位置を計算中)...");

        const analyzeRes = await fetch(`${SERVER_URL}/api/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });

        if (!analyzeRes.ok) throw new Error("BPM解析に失敗しました");
        const data = await analyzeRes.json();

        bpm = data.bpm;
        offsetSec = data.offset_sec;

        if (bpmInput) bpmInput.value = bpm;
        if (offsetInput) offsetInput.value = offsetSec;

        if (seekSlider) {
          seekSlider.max = audioBuffer.duration;
          seekSlider.value = 0;
          seekSlider.disabled = false;
        }

        setStatus(`読み込み完了! BPM: ${bpm}, オフセット: ${offsetSec}秒`);
        if (playBtn) playBtn.disabled = false;

      } catch (err) {
        console.error(err);
        setStatus(`エラー: ${err.message}`, true);
      }
    });
  }

  // 2. ローカルファイル読み込み
  if (localFileInput) {
    localFileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      initAudioContext();
      if (playBtn) playBtn.disabled = true;
      setStatus("ファイルを読み込み・解析中...");

      try {
        const arrayBuffer = await file.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(`${SERVER_URL}/api/analyze-local`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) throw new Error("解析に失敗しました");
        const data = await res.json();

        bpm = data.bpm;
        offsetSec = data.offset_sec;

        if (bpmInput) bpmInput.value = bpm;
        if (offsetInput) offsetInput.value = offsetSec;

        if (seekSlider) {
          seekSlider.max = audioBuffer.duration;
          seekSlider.value = 0;
          seekSlider.disabled = false;
        }

        setStatus(`読み込み完了! BPM: ${bpm}, オフセット: ${offsetSec}秒`);
        if (playBtn) playBtn.disabled = false;

      } catch (err) {
        console.error(err);
        setStatus(`エラー: ${err.message}`, true);
      }
    });
  }

  // 音量スライダーイベント
  if (musicVolInput) {
    musicVolInput.addEventListener("input", (e) => {
      if (musicGainNode) musicGainNode.gain.value = parseFloat(e.target.value);
    });
  }
  if (clickVolInput) {
    clickVolInput.addEventListener("input", (e) => {
      if (clickGainNode) clickGainNode.gain.value = parseFloat(e.target.value);
    });
  }

  // 再生位置シークバーの手動操作
  if (seekSlider) {
    seekSlider.addEventListener("input", (e) => {
      pauseOffset = parseFloat(e.target.value);
      if (currentTimeText) currentTimeText.textContent = `${pauseOffset.toFixed(1)}s`;
      
      if (isPlaying) {
        // 再生中に動かした場合は一度止めて移動先から再スタート
        stopPlayback();
        startPlayback(pauseOffset);
      }
    });
  }

  // パラメータ変更
  if (bpmInput) {
    bpmInput.addEventListener("change", (e) => {
      bpm = parseFloat(e.target.value) || 120;
    });
  }
  if (offsetInput) {
    offsetInput.addEventListener("change", (e) => {
      offsetSec = parseFloat(e.target.value) || 0;
    });
  }

  // 再生開始共通処理
  function startPlayback(pos) {
    initAudioContext();

    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(musicGainNode);

    startTime = audioContext.currentTime - pos;
    sourceNode.start(0, pos);

    // オフセットを含めた精度満点のクリックタイミング計算
    setupClickTiming(pos);
    scheduler();

    isPlaying = true;
    setStatus("再生中...");
    updateUI();

    sourceNode.onended = () => {
      if (audioContext.currentTime - startTime >= audioBuffer.duration) {
        stopPlayback();
        pauseOffset = 0;
        setStatus("再生完了");
      }
    };
  }

  // 停止共通処理
  function stopPlayback() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch(e){}
    }
    window.clearTimeout(timerID);
    cancelAnimationFrame(uiUpdateTimerID);
    isPlaying = false;
  }

  // 3. 再生 / 一時停止
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (!audioBuffer) return;

      if (isPlaying) {
        pauseOffset = audioContext.currentTime - startTime;
        stopPlayback();
        setStatus("一時停止中");
      } else {
        startPlayback(pauseOffset);
      }
    });
  }

  // 4. 停止 (最初に戻る)
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      stopPlayback();
      pauseOffset = 0;
      if (seekSlider) seekSlider.value = 0;
      if (currentTimeText) currentTimeText.textContent = "0.0s";
      setStatus("停止（最初に戻りました）");
    });
  }
});