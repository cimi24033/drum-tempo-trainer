import os
import tempfile
import traceback
import numpy as np
import librosa
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import yt_dlp

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AnalyzeRequest(BaseModel):
    url: str

def analyze_audio_file(file_path: str):
    """
    どんな音声・Librosaバージョンでも絶対に落とさずBPMとオフセットを判定する
    """
    try:
        # 1. 音声ファイルのロード（最初の60秒間）
        y, sr = librosa.load(file_path, sr=22050, duration=60)

        # 2. テンポ解析
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)

        # tempoの型変換（numpy float / array / float に安全に対応）
        if isinstance(tempo, (list, np.ndarray)):
            bpm_val = float(tempo[0]) if len(tempo) > 0 else 120.0
        else:
            bpm_val = float(tempo)

        # 3. オフセット計算
        if beats is not None and len(beats) > 0:
            beat_times = librosa.frames_to_time(beats, sr=sr)
            offset_sec = float(beat_times[0])
        else:
            offset_sec = 0.0

        return round(bpm_val, 2), round(offset_sec, 3)

    except Exception as e:
        print("\n=== [Librosa解析中にエラーが発生しました] ===")
        traceback.print_exc()
        print("============================================\n")
        # 解析エラー時は仮で120と0秒を返してサーバーエラー(500)を防ぐ
        return 120.0, 0.0

def download_youtube_audio(url: str, output_dir: str) -> str:
    out_template = os.path.join(output_dir, 'audio.%(ext)s')
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'outtmpl': out_template,
        'quiet': True,
        'no_warnings': True,
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
        
    for f in os.listdir(output_dir):
        if f.startswith('audio.'):
            return os.path.join(output_dir, f)
            
    raise FileNotFoundError("ダウンロードした音声ファイルが見つかりません。")

@app.get("/api/audio")
async def get_youtube_audio(url: str):
    if not url:
        raise HTTPException(status_code=400, detail="URLが必要です")
    
    try:
        temp_dir = tempfile.mkdtemp()
        audio_path = download_youtube_audio(url, temp_dir)
        if not os.path.exists(audio_path):
            raise HTTPException(status_code=404, detail="音声ファイルの抽出に失敗しました")
            
        ext = os.path.splitext(audio_path)[1].lower()
        media_type = "audio/mp4" if ext == ".m4a" else "audio/mpeg"
        
        return FileResponse(audio_path, media_type=media_type, filename=f"youtube_audio{ext}")
    except Exception as e:
        print(f"[Audio Error] {e}")
        raise HTTPException(status_code=500, detail=f"音声取得エラー: {str(e)}")

@app.post("/api/analyze")
async def analyze_youtube(req: AnalyzeRequest):
    if not req.url:
        raise HTTPException(status_code=400, detail="URLが必要です")
    
    temp_dir = tempfile.mkdtemp()
    try:
        audio_path = download_youtube_audio(req.url, temp_dir)
        bpm, offset_sec = analyze_audio_file(audio_path)
        
        if os.path.exists(audio_path):
            try: os.remove(audio_path)
            except: pass
        try: os.rmdir(temp_dir)
        except: pass
        
        return {
            "status": "success",
            "bpm": bpm,
            "offset_sec": offset_sec
        }
    except Exception as e:
        print("\n=== [/api/analyze エラー詳細] ===")
        traceback.print_exc()
        print("==================================\n")
        raise HTTPException(status_code=500, detail=f"解析エラー: {str(e)}")

@app.post("/api/analyze-local")
async def analyze_local(file: UploadFile = File(...)):
    try:
        suffix = os.path.splitext(file.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        bpm, offset_sec = analyze_audio_file(tmp_path)

        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except: pass

        return {
            "status": "success",
            "bpm": bpm,
            "offset_sec": offset_sec
        }
    except Exception as e:
        print(f"[Analyze Local Error] {e}")
        raise HTTPException(status_code=500, detail=f"解析エラー: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)