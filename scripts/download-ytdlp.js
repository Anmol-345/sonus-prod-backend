const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = os.platform();
const isWin = platform === 'win32';
const filename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
const dest = path.join(__dirname, '..', filename);

async function download() {
    console.log(`Downloading ${filename} for ${platform} to ${dest}...`);
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                if (!isWin) {
                    fs.chmodSync(dest, '755');
                }
                console.log('Download complete.');
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Error downloading: ${error.message}`);
        process.exit(1);
    }
}

download();
