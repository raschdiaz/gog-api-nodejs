import fs from 'fs';
import path from 'path';
import { normalizeDownloadedGameState, savePlatformGameState } from './config-store.js';
import { getHeaders } from './gog-api.js';
import {
  findPartFileByNames,
  findSavedPartFile,
  hasSavedPartName,
  normalizeSavedPartName
} from './installer-files.js';
import {
  downloadFileWithResume,
  parseSizeToBytes
} from './download-service.js';

export async function processGameInstallers({
  gameId,
  gameDetails,
  accessToken,
  platform,
  platformDownloadDir,
  platformDownloadedGames,
  config,
  savedPartNames,
  isOutdated
}) {
  const completedPartNames = new Set();
  const MAX_RETRIES = 60*60; // 1 hour of retries
  const RETRY_DELAY_MS = 1000; // 1 second

  let installerIndex = 0;
  for (const item of gameDetails.installers) {
    installerIndex++;
    const totalInstallers = gameDetails.installers.length;
    const folderName = item.gameTitle.replace(/[/\\?%*:|"<>]/g, '');
    const targetDir = path.join(platformDownloadDir, folderName);
    fs.mkdirSync(targetDir, { recursive: true });

    // Use the predicted filename for saving and resuming.
    const fileName = await getPredictedFilename(item, accessToken, platform);
    let filePath = path.join(targetDir, fileName);

    const legacyFileName = item.name.replace(/[/\\?%*:|"<>]/g, '_');
    const legacyFilePath = path.join(targetDir, legacyFileName);
    if (!fs.existsSync(filePath) && legacyFileName !== fileName && fs.existsSync(legacyFilePath)) {
      fs.renameSync(legacyFilePath, filePath);
      console.log(`  Renamed existing part ${legacyFileName} to ${fileName}.`);
    }

    const candidatePartNames = [
      item.name,
      legacyFileName,
      fileName,
      path.basename(filePath),
      path.basename(legacyFilePath)
    ];

    if (isOutdated) {
      for (const existingPartName of new Set([
        ...candidatePartNames,
        ...savedPartNames
      ])) {
        const existingPartPath = path.join(targetDir, normalizeSavedPartName(existingPartName));
        if (fs.existsSync(existingPartPath)) fs.unlinkSync(existingPartPath);
      }
      filePath = path.join(targetDir, fileName);
    }

    if (!fs.existsSync(filePath)) {
      const existingPartPath = findPartFileByNames(targetDir, candidatePartNames);
      if (existingPartPath) {
        fs.renameSync(existingPartPath, filePath);
        console.log(`  Renamed existing part ${path.basename(existingPartPath)} to ${fileName}.`);
      }
    }

    if (!fs.existsSync(filePath) && gameDetails.installers.length === 1 && savedPartNames.size > 0) {
      const savedPartPath = findSavedPartFile(targetDir, savedPartNames);
      if (savedPartPath) {
        filePath = savedPartPath;
        console.log(`  Found existing saved part under ${path.basename(savedPartPath)}; using it for ${fileName}.`);
      }
    }

    const partAlreadyRecorded = hasSavedPartName(savedPartNames, candidatePartNames);

    const expectedSize = parseSizeToBytes(item.size);
    const fileExists = fs.existsSync(filePath);
    const completedFileSize = fileExists ? fs.statSync(filePath).size : 0;
    const isPartComplete = expectedSize > 0
      && fileExists
      && Math.abs(completedFileSize - expectedSize) <= Math.max(1024, expectedSize * 0.001);

    if (partAlreadyRecorded && !fileExists) {
      console.warn(`[${item.gameTitle}] (${installerIndex}/${totalInstallers}) -> Saved part is marked in config but the file is missing. Re-downloading ${fileName}.`);
    }

    if ((partAlreadyRecorded || isPartComplete) && fileExists) {
      console.log(`[${item.gameTitle}] (${installerIndex}/${totalInstallers}) -> ${fileName} already downloaded. Skipping part.`);
      completedPartNames.add(fileName);
      continue;
    }

    let retries = 0;
    let downloadSuccess = false;
    while (retries < MAX_RETRIES && !downloadSuccess) {
      try {
        console.log(`[${item.gameTitle}] (${installerIndex}/${totalInstallers}) -> ${fileName}`);
        await downloadFileWithResume(item.manualUrl, filePath, accessToken);
        completedPartNames.add(fileName);
        platformDownloadedGames[gameId] = {
          title: gameDetails.title,
          parts: [...completedPartNames],
          downloadedDate: null
        };
        savePlatformGameState(config, platform, platformDownloadedGames);
        console.log(`  Saved download state for ${fileName}.`);
        downloadSuccess = true; // Success, exit retry loop
      } catch (err) {
        // Handle 404 Not Found errors gracefully
        if (err.message.includes('HTTP 404')) {
          console.warn(`\n  Warning: File not found on server (404). Skipping: ${fileName}`);
          downloadSuccess = true; // Mark as "success" to skip retries and move to the next file.
          break; // Exit the retry loop for this file.
        }

        const networkErrorCodes = [
          'ABORT_ERR',
          'ECONNRESET',
          'EAI_AGAIN',
          'ENETUNREACH',
          'ENOTFOUND',
          'ERR_DOWNLOAD_INCOMPLETE',
          'ERR_DOWNLOAD_CURL',
          'ERR_DOWNLOAD_STREAM',
          'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_SOCKET'
        ];
        const errorCodes = [
          err.code,
          err.cause?.code,
          err.cause?.cause?.code
        ];
        const isNetworkError = errorCodes.some(code => networkErrorCodes.includes(code));
        if (isNetworkError) {
          retries++;
          const reason = err.code === 'ERR_DOWNLOAD_INCOMPLETE'
            ? 'Download ended before the expected file length'
            : err.code === 'ERR_DOWNLOAD_CURL'
              ? `Download connection failed (${err.message})`
              : `Network error (${err.message})`;
          console.warn(`\n  ${reason}. Retrying in ${RETRY_DELAY_MS / 1000}s... (${retries}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          throw err; // Not a retriable network error, re-throw it
        }
      }
    }
    if (!downloadSuccess) {
      throw new Error(`Download for ${fileName} failed after ${MAX_RETRIES} retries.`);
    }
  }

  const finalGameState = normalizeDownloadedGameState(gameId, platformDownloadedGames[gameId], gameDetails.title);
  finalGameState.parts = [...completedPartNames];
  finalGameState.downloadedDate = completedPartNames.size === gameDetails.installers.length
    ? new Date().toISOString()
    : null;
  platformDownloadedGames[gameId] = finalGameState;

  // After all installers for the game are downloaded, mark it as complete.
  savePlatformGameState(config, platform, platformDownloadedGames);
  console.log(`[${gameDetails.title}] successfully downloaded and marked as complete.`);
}

async function getPredictedFilename(item, accessToken, targetPlatform) {
  let predictedName = item.name;

  try {
    const res = await fetch(`https://embed.gog.com${item.manualUrl}`, {
      method: 'HEAD',
      headers: getHeaders(accessToken),
      redirect: 'follow'
    });

    const contentDisposition = res.headers.get('content-disposition');
    const dispositionMatch = contentDisposition?.match(
      /filename\*=UTF-8''([^;]+)|filename=['"]?([^;'\"]+)['"]?/i
    );
    const dispositionName = dispositionMatch?.[1] || dispositionMatch?.[2];
    if (dispositionName) {
      try {
        predictedName = decodeURIComponent(dispositionName);
      } catch {
        predictedName = dispositionName;
      }
    } else if (res.ok) {
      const urlName = path.basename(new URL(res.url).pathname);
      if (urlName) predictedName = urlName;
    }
  } catch {
    // Fall back to the API name when the filename lookup fails.
  }

  if (!path.extname(predictedName) && targetPlatform === 'windows') {
    predictedName += '.exe';
  }

  // Sanitize the name to remove invalid characters.
  predictedName = predictedName.replace(/[/\\?%*:|"<>]/g, '_');
  return predictedName;
}

