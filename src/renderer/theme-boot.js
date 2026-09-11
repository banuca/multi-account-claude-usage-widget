// Applies the saved theme to <html> before the stylesheet paints.
//
// This is a file rather than an inline <script> on purpose: the page's
// Content-Security-Policy is `script-src 'self'`, and loosening that to
// 'unsafe-inline' to save one request would be a poor trade for a colour
// scheme. It still runs synchronously in <head>, before any of the body is
// laid out, so neither palette flashes.
//
// The value comes from the preload script, which Electron runs before any page
// script and which reads it from the window's own command line (main.js puts it
// there when it creates the window). No IPC, nothing to await.
(function () {
    'use strict';
    var theme = 'dark';
    try {
        if (window.electronAPI && window.electronAPI.initialTheme === 'light') theme = 'light';
    } catch (error) {
        // Keep the default. A missing preload is not a reason to fail to paint.
    }
    document.documentElement.dataset.theme = theme;
}());
