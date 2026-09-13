# GOG Offline Backup Script

A Node.js command-line script to download your GOG.com game library for offline backup. It provides a range of features to make managing and downloading your games efficient and user-friendly.

## Features

*   **Secure Authentication:**
    *   Interactive, browser-based login for the first run.
    *   Automatic token refresh for subsequent sessions.
    *   Securely stores authentication tokens locally in `config.json`.

*   **Intelligent Downloading:**
    *   **Linux-Friendly Downloads:** Uses a more robust transfer path on Linux with better retry and resume behavior for large game installer files.
    *   **Resumable Downloads:** Automatically resumes interrupted downloads from where they left off.
    *   **Skips Completed Games:** Intelligently checks for existing files and their sizes to skip games that are already fully downloaded.
    *   **Robust Filename Detection:** Ensures correct filenames and extensions by checking API metadata, `Content-Disposition` headers, and download URLs.
    *   **Organized Structure:** Saves each game's installers into a platform-specific folder (e.g., `./gog_offline_backup/windows/The Witcher 3 Wild Hunt/`).
    *   **Network Resilience:** Automatically pauses and retries downloads if the internet connection is lost, attempting to resume from the point of interruption.

*   **Powerful Filtering:**
    *   **Filter by Tags:** Interactively prompts you to enter tags (e.g., `RPG, Action`) to download only specific games.
    *   Lists all available tags from your library for easy reference.

*   **User-Friendly Configuration:**
    *   **Interactive Setup:** Prompts for the download directory, installer operating system, and filter tags on run.
    *   **Persistent Settings:** Remembers your last-used download directory, installer OS, and tags in `config.json` for convenience.
    *   **Operating-System Selection:** Lets you choose the GOG installer type to download (`windows`, `mac`, or `linux`) before starting the backup.

*   **Detailed Console Output:**
    *   Real-time progress bar for each download, including speed, percentage, and ETA.
    *   Clear status messages for authentication, filtering, and completed downloads.

## Prerequisites

*   Node.js (v18 or later is recommended).

## Setup

1.  Save the script as `index.js` in a new folder.
2.  Open a terminal or command prompt in that folder.
3.  The script uses only built-in Node.js modules, so no `npm install` is required.

## Usage

Run the script from your terminal:
```sh
node index.js
```

### First Run
1.  The script will ask you to open a URL in your browser to log into your GOG account.
2.  After logging in, you will be redirected to a page with a `code=` parameter in the URL.
3.  Copy the entire URL and paste it back into the terminal.
4.  The script will then prompt you to enter a download directory, the installer operating system, and optional tags for filtering.

### Subsequent Runs
The script will automatically use your saved authentication token. It will prompt you for the download directory, installer OS, and tags, using your previously saved choices as the default.

### Choosing the Installer OS
The script supports downloading installers for different operating systems:

* `windows`
* `mac`
* `linux`

Pick the one you want before the library scan starts. This is useful if you want to back up installers for a platform different from the current machine.

## Configuration Files

The script will create a `config.json` file in the same directory. This file stores:

*   Your authentication and refresh tokens so you don't have to log in every time. **Do not share this file.**
*   Your preferred download directory, selected installer OS, and filter tags.
*   Download completion state grouped by platform under `downloadedGames`, so the same game can be downloaded separately for Windows, macOS, and Linux.

You can edit this file manually if you wish. On its first run, the script will automatically migrate any old `tokens.json` file into this new format and delete the old file.