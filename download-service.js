import fs from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getHeaders } from './gog-api.js';

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function drawProgressBar(downloaded, total, speedBytesPerSec) {
  const barLength = 20;
  const hasTotal = total > 0;
  const percentage = hasTotal ? (downloaded / total) * 100 : 0;
  const filledLength = hasTotal ? Math.min(barLength, Math.round((barLength * percentage) / 100)) : 0;
  const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
  const remainingBytes = total - downloaded;
  const etaSeconds = speedBytesPerSec > 0 && remainingBytes > 0
    ? Math.ceil(remainingBytes / speedBytesPerSec)
    : 0;
  const pctString = hasTotal ? `${percentage.toFixed(1).padStart(5)}%` : '  N/A';
  const totalString = hasTotal ? formatBytes(total) : 'Unknown';
  const etaString = etaSeconds > 0 ? `${etaSeconds}s` : '--';

  process.stdout.write(
    `\r  [${bar}] ${pctString} | ${formatBytes(downloaded)} / ${totalString} | ${formatBytes(speedBytesPerSec)}/s | ETA: ${etaString}`
  );
}

export function parseSizeToBytes(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') return 0;
  const [value, unit] = sizeString.split(' ');
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return 0;

  const k = 1024;
  switch (unit?.toUpperCase()) {
    case 'GB': return Math.round(numValue * k * k * k);
    case 'MB': return Math.round(numValue * k * k);
    case 'KB': return Math.round(numValue * k);
    default: return Math.round(numValue);
  }
}

export async function downloadFileWithCurl(downloadUrl, savePath, accessToken, allowRangeRestart = true) {
  const headers = getHeaders(accessToken);
  const curlArgs = [
    '--fail', '--location', '--connect-timeout', '15', '--max-time', '0',
    '--speed-limit', '1024', '--speed-time', '60', '--http2',
    '--user-agent', headers['User-Agent'], '--header', `Authorization: Bearer ${accessToken}`,
    '--write-out', '%{http_code}', '--output', savePath
  ];

  const existingSize = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
  if (existingSize > 0) {
    curlArgs.push('--continue-at', '-');
    console.log(`  Resuming download from byte offset ${formatBytes(existingSize)}...`);
  }

  const curl = spawn('curl', [...curlArgs, downloadUrl], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    let httpStatus = '';
    curl.stdout.on('data', chunk => { httpStatus += chunk.toString(); });
    curl.on('error', reject);
    curl.on('close', code => {
      if (code === 0) resolve();
      else if (code === 22 && httpStatus.trim() === '416' && existingSize > 0 && allowRangeRestart) {
        fs.unlinkSync(savePath);
        console.warn('  Server rejected the resume offset; restarting this file from byte zero.');
        downloadFileWithCurl(downloadUrl, savePath, accessToken, false).then(resolve, reject);
      } else {
        const error = new Error(`curl exited with code ${code}${httpStatus ? ` (HTTP ${httpStatus.trim()})` : ''}`);
        error.code = 'ERR_DOWNLOAD_CURL';
        reject(error);
      }
    });
  });
}

export async function downloadFileWithResume(manualUrl, savePath, accessToken) {
  const downloadUrl = `https://embed.gog.com${manualUrl}`;
  const curlReady = await new Promise(resolve => {
    const curlCheck = spawn('curl', ['--version'], { stdio: 'ignore' });
    curlCheck.on('error', () => resolve(false));
    curlCheck.on('close', code => resolve(code === 0));
  });

  if (curlReady) {
    await downloadFileWithCurl(downloadUrl, savePath, accessToken);
    return;
  }

  const existingSize = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
  const requestHeaders = getHeaders(accessToken);
  if (existingSize > 0) requestHeaders.Range = `bytes=${existingSize}-`;

  const res = await fetch(downloadUrl, { headers: requestHeaders, redirect: 'follow' });
  if (res.status === 416) {
    const totalMatch = res.headers.get('content-range')?.match(/bytes \*\/(\d+)/i);
    const totalSize = totalMatch ? Number(totalMatch[1]) : 0;
    if (totalSize === 0 || existingSize >= totalSize) return;
    throw new Error('HTTP 416: the existing partial file is larger than the remote file');
  }
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const isPartial = existingSize > 0 && res.status === 206;
  const contentRange = res.headers.get('content-range');
  let remoteTotalSize = 0;
  if (isPartial) {
    const rangeMatch = contentRange?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/i);
    if (!rangeMatch || Number(rangeMatch[1]) !== existingSize) {
      throw new Error('HTTP 206: server returned an invalid range for the existing partial file');
    }
    if (rangeMatch[2] !== '*') remoteTotalSize = Number(rangeMatch[2]);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const totalSize = remoteTotalSize || (isPartial ? existingSize + contentLength : contentLength);
  const fileStream = fs.createWriteStream(savePath, { flags: isPartial ? 'a' : 'w' });
  const nodeReadable = Readable.fromWeb(res.body);
  let downloadedInSession = 0;
  let lastReportTime = Date.now();
  let bytesSinceLastReport = 0;
  let currentSpeed = 0;

  nodeReadable.on('data', chunk => {
    downloadedInSession += chunk.length;
    bytesSinceLastReport += chunk.length;
    const now = Date.now();
    const timeDiff = (now - lastReportTime) / 1000;
    if (timeDiff >= 0.5) {
      currentSpeed = bytesSinceLastReport / timeDiff;
      lastReportTime = now;
      bytesSinceLastReport = 0;
    }
    drawProgressBar(existingSize + downloadedInSession, totalSize, currentSpeed);
  });

  try {
    await pipeline(nodeReadable, fileStream);
  } catch (err) {
    err.code = err.code || 'ERR_DOWNLOAD_STREAM';
    throw err;
  }

  const actualFileSize = fs.statSync(savePath).size;
  const expectedFileSize = remoteTotalSize || (contentLength > 0
    ? (isPartial ? existingSize + contentLength : contentLength)
    : 0);
  if (expectedFileSize > 0 && actualFileSize !== expectedFileSize) {
    const error = new Error(`Download ended early (${formatBytes(actualFileSize)} of ${formatBytes(expectedFileSize)} received)`);
    error.code = 'ERR_DOWNLOAD_INCOMPLETE';
    throw error;
  }

  drawProgressBar(existingSize + downloadedInSession, totalSize, 0);
  process.stdout.write('\n');
}
