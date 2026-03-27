const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const axios = require('axios');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(REDIS_URL);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*';

app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
}));
app.use(express.json());

const COOKIES_FILE = process.env.COOKIES_FILE_PATH || path.join(__dirname, 'cookies.txt');

const getCookieArgs = () => {
    if (fs.existsSync(COOKIES_FILE)) {
        return ['--cookies', COOKIES_FILE];
    }
    return [];
};

const isWin = process.platform === 'win32';
const localBin = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_BIN = fs.existsSync(localBin) 
    ? localBin 
    : (process.env.YTDLP_PATH || 'yt-dlp');

const COMMON_ARGS = [
    '--no-warnings',
    '--no-js-runtimes', '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
];

// Fallback search using CLI (Search is less latency-critical than streaming)
const runYtdlp = (args) => {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_BIN, [...COMMON_ARGS, ...getCookieArgs(), ...args]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('error', (err) => reject(new Error(`yt-dlp error: ${err.message}`)));
        proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
};

// API: Search (with Predictive Pre-fetch)
app.get('/api/search', async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    try {
        const safeLimit = Math.min(parseInt(limit) || 20, 50);
        const args = [
            `ytsearch${safeLimit}:${q}`,
            '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s|%(view_count)s',
            '--flat-playlist',
            '--no-playlist',
        ];

        const output = await runYtdlp(args);
        const results = output.trim().split('\n').map(line => {
            const [id, title, channel, duration, thumbnailUrl, viewCount] = line.split('|');
            if (!id) return null;
            return { id, title, channel, duration: parseInt(duration) || 0, thumbnailUrl, viewCount: parseInt(viewCount) || 0 };
        }).filter(Boolean);

        // PREDICTIVE PRE-FETCH: Trigger background extraction for Top 3 results
        const topIds = results.slice(0, 3).map(r => r.id);
        if (topIds.length > 0) {
            axios.post(`${PYTHON_SERVICE_URL}/prefetch`, { video_ids: topIds })
                .catch(err => console.error('[prefetch] error:', err.message));
        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// API: Info
app.get('/api/info/:videoId', async (req, res) => {
    const { videoId } = req.params;
    try {
        const output = await runYtdlp([
            `https://www.youtube.com/watch?v=${videoId}`,
            '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s|%(description)s',
            '--no-playlist',
        ]);
        const [id, title, channel, duration, thumbnailUrl, ...descriptionParts] = output.trim().split('|');
        res.json({ id, title, channel, duration: parseInt(duration) || 0, thumbnailUrl, description: descriptionParts.join('|') });
    } catch (error) {
        res.status(500).json({ error: 'Info failed', details: error.message });
    }
});

// API: Stream (Calls Python Service + Redis)
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        // 1. Efficient Redis Check (Gateway Layer)
        const cached = await redis.get(`stream:${videoId}`);
        if (cached) {
            console.log(`[GW cache hit] ${videoId}`);
            return res.json({ url: cached });
        }

        // 2. Call Python Service (Extraction Layer)
        console.log(`[GW cache miss] Requesting python extractor for ${videoId}`);
        const response = await axios.get(`${PYTHON_SERVICE_URL}/extract/${videoId}`, { timeout: 10000 });
        res.json({ url: response.data.url });
    } catch (error) {
        console.error('Stream error:', error.message);
        res.status(500).json({ error: 'Stream extraction failed' });
    }
});

app.get('/api/health', async (req, res) => {
    try {
        const pyHealth = await axios.get(`${PYTHON_SERVICE_URL}/health`).catch(e => ({ data: { status: 'offline' } }));
        res.json({ status: 'ok', python_service: pyHealth.data });
    } catch (error) {
        res.status(500).json({ status: 'error' });
    }
});

process.on('SIGTERM', () => process.exit(0));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gateway running on port ${PORT}`);
    console.log(`Python Service URL: ${PYTHON_SERVICE_URL}`);
});
