import fs from 'fs';
import path from 'path';

export function normalizeSavedPartName(partName) {
  if (typeof partName !== 'string') return '';
  return partName.trim().replace(/[\/\\?%*:|"<>]/g, '_');
}

export function hasSavedPartName(savedPartNames, candidateNames) {
  const normalizedSaved = new Set(
    [...savedPartNames].map(normalizeSavedPartName).filter(Boolean)
  );
  return [...new Set(candidateNames.map(normalizeSavedPartName).filter(Boolean))]
    .some(name => normalizedSaved.has(name));
}

export function findSavedPartFile(targetDir, savedPartNames) {
  return findFileByNames(targetDir, savedPartNames);
}

export function findPartFileByNames(targetDir, partNames) {
  return findFileByNames(targetDir, partNames);
}

function findFileByNames(targetDir, partNames) {
  if (!fs.existsSync(targetDir)) return null;

  const normalizedNames = new Set(
    partNames.map(normalizeSavedPartName).filter(Boolean)
  );
  const matchingFiles = fs.readdirSync(targetDir)
    .map(fileName => path.join(targetDir, fileName))
    .filter(filePath => fs.statSync(filePath).isFile()
      && normalizedNames.has(normalizeSavedPartName(path.basename(filePath))));

  return matchingFiles.length === 1 ? matchingFiles[0] : null;
}
