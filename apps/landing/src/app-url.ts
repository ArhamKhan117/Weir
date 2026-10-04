/**
 * Where the app is. Every "Open Weir" control on the page goes here.
 *
 * A new tab rather than a navigation: the landing page is the thing a visitor was sent, often from
 * a chat or a submission, and taking it away from them to open an app is the wrong trade.
 *
 * Set `NEXT_PUBLIC_APP_URL` wherever the site is built for a real host; the fallback is the web
 * app's local development server.
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";
