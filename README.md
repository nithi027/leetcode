# vsbpat — Stealth AI Assessment Solver

A specialized browser extension designed for strict full-screen online assessments (e.g. VSB PAT, Mettl, HackerEarth, Talview, Canvas, etc.) where tab-switching, window blurring, or OS notifications trigger immediate auto-submission.

---

## ⚡ Key Highlights

- **3 Dedicated Shortcuts**:
  - `Alt + A` *(or `Ctrl + Shift + S`)*: **Auto-Type / Select MCQ** — Solves question and directly types the solution into Monaco, CodeMirror, Ace, textareas, or auto-clicks the correct MCQ option.
  - `Alt + S` *(or `Ctrl + Shift + P`)*: **In-Page Popup (Overlay)** — Injects a draggable, floating glassmorphism card directly inside the full-screen test page. **Never opens the extension window or causes tab switches**. Press `Esc` or `Alt+S` again to toggle off.
  - `Alt + C` *(or `Ctrl + Shift + Y`)*: **Quick Copy** — Copies the pure answer or code directly to your clipboard with an unobtrusive 1.5s micro-HUD.
- **Zero Login Required**: Direct-to-AI calls using your own free API key stored safely in `chrome.storage.local`. No accounts, no subscriptions, no credit limits.
- **Proctoring-Proof & Fullscreen Safe**:
  - Encapsulated inside **Closed Shadow DOM** (`#vsbpat-overlay-host`) so exam scripts and CSS cannot interfere.
  - Zero `blur` or `visibilitychange` window events.
  - Completely eliminates browser/OS system notifications that trigger auto-submit warnings.
- **Human-like Typing Simulation**: Optional keystroke streaming mode to bypass portals that track paste events or typing speed.

---

## 🚀 Recommended Free AI Models

### 1. Groq Cloud (Recommended #1 — Fastest Inference in the World)
- **Model**: `openai/gpt-oss-120b` (or `qwen/qwen3.8-27b`)
- **Speed**: **0.3 – 0.6 seconds** per response (~300+ tokens/sec).
- **Accuracy**: High-parameter 120B reasoning model with exceptional coding and MCQ precision.
- **Cost**: **100% Free** (generous free tier: 30 requests/min).
- **How to get key**:
  1. Go to [console.groq.com/keys](https://console.groq.com/keys)
  2. Sign in with Google / GitHub.
  3. Click **Create API Key**, copy it, and paste it into vsbpat settings.

### 2. Google Gemini (Recommended #2 — High Accuracy)
- **Model**: `gemini-flash-latest` (or `gemini-3.8-flash`)
- **Speed**: ~1.0 – 2.0 seconds per response.
- **Accuracy**: Google's flagship multimodal model with deep technical reasoning.
- **Cost**: **100% Free** via Google AI Studio.
- **How to get key**:
  1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  2. Sign in with your Google account.
  3. Click **Create API Key**, copy it, and paste it into vsbpat settings.

---

## 🛠️ Installation & Setup (One-Time)

1. Open Google Chrome (or Brave / Edge).
2. Go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle switch in the top-right corner).
4. Click **Load unpacked** in the top-left.
5. Select the folder:
   `/media/nithish/Nithisshh/xtension/v2/vsbpat`
6. Click the extension icon in your browser toolbar to open the settings:
   - Select your provider (**Groq** or **Gemini**).
   - Paste your **API Key**.
   - Click **⚡ Test API** to verify the connection.
   - Click **Save Settings**.

---

## 🎯 How to Use During an Exam

1. Enter your exam in **Full Screen**.
2. **DO NOT** click the extension toolbar icon or switch tabs during the exam.
3. Simply use your keyboard:
   - To **auto-fill the code editor or select the MCQ**: Press <kbd>Alt</kbd> + <kbd>A</kbd>
   - To **view the answer in a floating card on-screen**: Press <kbd>Alt</kbd> + <kbd>S</kbd> (drag anywhere, or press <kbd>Esc</kbd> to hide)
   - To **copy the code/answer to clipboard**: Press <kbd>Alt</kbd> + <kbd>C</kbd>
4. If a question is complex or part of a long page, you can highlight/select the question text with your mouse and press any of the shortcuts.
