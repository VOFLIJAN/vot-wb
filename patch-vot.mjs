// Patch VOT userscript for wBlock (v3).
// VOT Worker requests go through the page's own fetch (the proxy allows CORS *),
// bypassing wBlock's GM_xmlhttpRequest: it drops binary bodies, caps bodies at 2 MB,
// and its native helper has no network access. Falls back to the JSON envelope via GM.
// usage: node patch-vot.mjs <in.user.js> <out.user.js> [release-download-base-url]
// Bump PATCH_REV on every patch change: the published version is <upstream>.<PATCH_REV>.
const PATCH_REV = 1;
import fs from 'node:fs';
const [,, input, output, distBase] = process.argv;
let src = fs.readFileSync(input, 'utf8');
const anchor = 'var VOTNextWorkerProvider = class extends YandexProvider {';
if (src.split(anchor).length !== 2) throw new Error('anchor not found exactly once');
const methods = `
		// wBlock fix v3: see header comment of the patch.
		wblockPageInit(options) {
			const headers = {};
			for (const [key, value] of Object.entries(options.headers ?? {})) {
				const name = key.toLowerCase();
				if (name === "user-agent" || name.startsWith("sec-") || name === "pragma" || name === "cache-control") continue;
				headers[key] = value;
			}
			const init = { method: options.method, headers, body: options.body, mode: "cors", credentials: "omit" };
			if (options.signal) init.signal = options.signal;
			return init;
		}
		async request(path, body, headers = {}, method = "POST", fetchOpts = {}) {
			const url = \`\${this.schema}://\${this.host}\${path}\`;
			try {
				const options = this.getOpts(new Blob([body]), headers, method, fetchOpts);
				const res = await fetch(url, this.wblockPageInit(options));
				const data = await res.arrayBuffer();
				return { success: res.status === 200, data };
			} catch (err) {
				if (fetchOpts?.signal?.aborted) return { success: false, data: err?.message };
			}
			let innerHeaders = {};
			try {
				innerHeaders = JSON.parse(atob(headers["X-VOT-Headers"] ?? ""));
			} catch {
				innerHeaders = { ...this.headers };
			}
			const options = {
				method,
				headers: { Accept: "application/x-protobuf", "Content-Type": "application/json" },
				body: JSON.stringify({ headers: innerHeaders, body: Array.from(body) }),
				...this.fetchOpts,
				...fetchOpts
			};
			try {
				const res = await this.fetch(url, options);
				const data = await res.arrayBuffer();
				return { success: res.status === 200, data };
			} catch (err) {
				return { success: false, data: err?.message };
			}
		}
		async requestJSON(path, body = null, headers = {}, method = "POST", fetchOpts = {}) {
			const options = this.getOpts(body, {
				Accept: "application/json",
				"Content-Type": "application/json",
				...headers
			}, method, fetchOpts);
			try {
				const res = await fetch(\`\${this.schema}://\${this.host}\${path}\`, this.wblockPageInit(options));
				const data = await res.json();
				return { success: res.status === 200, data };
			} catch (err) {
				return { success: false, data: err?.message };
			}
		}`;
src = src.replace(anchor, anchor + methods);
// wBlock: block translation by the ORIGINAL audio language of a YouTube video.
// wBlock runs this script in the isolated content world (it grants GM_*), so the page's
// #movie_player methods (getPlayerResponse, getAudioTrack) are not visible here and VOT never
// learns the video language; its title-based fallback returns "en" when its detect API fails.
// YouTube also auto-dubs ru/uk videos to English (track "en-US.10", played by default).
// So: fetch the watch page and read the original track ("xx.4"), else the single ASR caption ("a.xx").
// Ukrainian is not in availableLangs, so it cannot go into dontTranslateLanguages: block it always.
const validatorLine = 'if (this.videoHandler.data.dontTranslateLanguages?.includes(this.videoHandler.videoData.detectedLanguage)) throw new VOTLocalizedError("VOTDisableFromYourLang");';
if (src.split(validatorLine).length !== 2) throw new Error('validator line not found exactly once');
src = src.replace(validatorLine, validatorLine + `
			if (this.videoHandler.site.host === "youtube") {
				const wblockLangs = await this.wblockOriginalLanguages(this.videoHandler.videoData.videoId);
				const blocked = ["uk", ...this.videoHandler.data.dontTranslateLanguages ?? []];
				debug.log("[wBlock] original audio languages", wblockLangs, "blocked", blocked);
				if (wblockLangs.some((lang) => blocked.includes(lang))) throw new VOTLocalizedError("VOTDisableFromYourLang");
			}`);
const validatorHead = 'async videoValidator() {';
if (src.split(validatorHead).length !== 2) throw new Error('videoValidator head not found exactly once');
src = src.replace(validatorHead, `async wblockOriginalLanguages(videoId) {
			if (typeof videoId !== "string" || !videoId) return [];
			const cache = VOTVideoManager.wblockLangCache ??= new Map();
			if (cache.has(videoId)) return cache.get(videoId);
			const url = \`https://www.youtube.com/watch?v=\${encodeURIComponent(videoId)}&bpctr=9999999999\`;
			let html = "";
			try {
				html = await (await fetch(url, { credentials: "include" })).text();
			} catch {}
			if (!html.includes("playabilityStatus")) try {
				html = await (await GM_fetch(url, { timeout: 1e4 })).text();
			} catch {}
			if (!html.includes("playabilityStatus")) return [];
			const collect = (re) => [...new Set([...html.matchAll(re)].map((m) => normalizeLang$1(m[1])))];
			let langs = collect(/"(?:audioTrackId|id)":"([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\\.4"/g);
			if (!langs.length) {
				const asr = collect(/"vssId":"a\\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)"/g);
				if (asr.length === 1) langs = asr;
			}
			cache.set(videoId, langs);
			return langs;
		}
		` + validatorHead);
// Safari can leave the AudioContext "interrupted" (not only "suspended"), e.g. after a tab switch.
// VOT resumes only "suspended", so the button turns blue but the translation stays silent.
const ctxChecks = [
	['if (this.chaimu.audioContext?.state === "suspended") await', 'if (["suspended", "interrupted"].includes(this.chaimu.audioContext?.state)) await'],
	['if (this.chaimu.audioContext.state === "suspended") await', 'if (["suspended", "interrupted"].includes(this.chaimu.audioContext.state)) await'],
	['if (ctx?.state !== "suspended") return "not-needed";', 'if (!["suspended", "interrupted"].includes(ctx?.state)) return "not-needed";']
];
for (const [from, to] of ctxChecks) {
	if (src.split(from).length !== 2) throw new Error('AudioContext check not found exactly once: ' + from);
	src = src.replace(from, to);
}
src = src.replace(/^(\/\/ @name {11}.*)$/m, '$1 (wBlock fix)');
src = src.replace(/^\/\/ @(downloadURL|updateURL) .*\n/gm, '');
if (!/^\/\/ @version +\S+$/m.test(src)) throw new Error('@version not found');
src = src.replace(/^(\/\/ @version +)(\S+)$/m, `$1$2.${PATCH_REV}`);
if (distBase) src = src.replace(/^(\/\/ @version .*\n)/m, `$1// @updateURL      ${distBase}/vot.meta.js\n// @downloadURL    ${distBase}/vot.user.js\n`);
fs.writeFileSync(output, src);
console.log('patched ->', output);
