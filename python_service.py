import os
import asyncio
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import yt_dlp
import redis.asyncio as redis
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
COOKIES_FILE = os.getenv("COOKIES_FILE_PATH", "cookies.txt")
CACHE_TTL = 4 * 60 * 60  # 4 hours

# Global Redis Connection
redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# Global yt-dlp instance (Persistent Session)
YTDL_OPTS = {
    'format': 'bestaudio/best',
    'quiet': True,
    'no_warnings': True,
    'cookiefile': COOKIES_FILE if os.path.exists(COOKIES_FILE) else None,
    'source_address': '0.0.0.0', # Bind to ipv4
}

ytdl = yt_dlp.YoutubeDL(YTDL_OPTS)

class PrefetchRequest(BaseModel):
    video_ids: list[str]

async def extract_info(video_id: str):
    """Internal helper to extract URL using the persistent ytdl instance."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    loop = asyncio.get_event_loop()
    try:
        # run_in_executor to avoid blocking the event loop with synchronous yt-dlp calls
        info = await loop.run_in_executor(None, lambda: ytdl.extract_info(url, download=False))
        stream_url = info.get('url')
        if stream_url:
            await redis_client.set(f"stream:{video_id}", stream_url, ex=CACHE_TTL)
            return stream_url
    except Exception as e:
        print(f"Error extracting {video_id}: {e}")
    return None

@app.get("/extract/{video_id}")
async def get_stream_url(video_id: str):
    # 1. Check Redis
    cached_url = await redis_client.get(f"stream:{video_id}")
    if cached_url:
        return {"url": cached_url, "source": "cache"}

    # 2. Extract
    stream_url = await extract_info(video_id)
    if not stream_url:
        raise HTTPException(status_code=500, detail="Failed to extract stream URL")
    
    return {"url": stream_url, "source": "extractor"}

@app.post("/prefetch")
async def prefetch_urls(request: PrefetchRequest, background_tasks: BackgroundTasks):
    for video_id in request.video_ids:
        # Check if already cached to avoid redundant work
        if not await redis_client.exists(f"stream:{video_id}"):
            background_tasks.add_task(extract_info, video_id)
    return {"status": "queued", "count": len(request.video_ids)}

@app.get("/health")
async def health():
    return {"status": "ok", "ytdl_version": yt_dlp.version.__version__}

if __name__ == "__main__":
    import uvicorn
    # Use a specific variable for Python port to avoid conflict with Node GATEWAY PORT
    port = int(os.getenv("PYTHON_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
