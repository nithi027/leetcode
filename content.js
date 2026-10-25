// vsbpat — Content Script
// Stealth In-Page Assessment Controller:
// - Closed Shadow DOM floating answer popup (zero window blur / tab switch)
// - Dual-layer shortcut listeners (Alt+A, Alt+S, Alt+C and Ctrl+Shift+...)
// - Smart Question, MCQ, & Code context extraction
// - Automated Editor & MCQ injection (Monaco, CodeMirror, Textarea, Radio options)
// - Clipboard copy with stealth micro HUD

(function () {
  if (window.__vsbpat_initialized) return;
  window.__vsbpat_initialized = true;

  // -------------------------------------------------------------
  // 1. Dual-Layer Keyboard Shortcut Listener (Capture Phase)
  // -------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    // Check for popup toggle dismissal (Esc key closes in-page popup if open)
    if (e.key === 'Escape' && isPopupVisible()) {
      e.preventDefault();
      e.stopPropagation();
      hidePopup();
      return;
    }

    // Shortcut 1: Auto-Type (Alt+A or Ctrl+Shift+S)
    const isAutoType = (e.altKey && (e.code === 'KeyA' || e.key.toLowerCase() === 'a')) ||
                       (e.ctrlKey && e.shiftKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's'));

    // Shortcut 2: Show In-Page Popup (Alt+S or Ctrl+Shift+P)
    const isShowPopup = (e.altKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's')) ||
                        (e.ctrlKey && e.shiftKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p'));

    // Shortcut 3: Direct Copy (Alt+C or Ctrl+Shift+Y)
    const isDirectCopy = (e.altKey && (e.code === 'KeyC' || e.key.toLowerCase() === 'c')) ||
                         (e.ctrlKey && e.shiftKey && (e.code === 'KeyY' || e.key.toLowerCase() === 'y'));

    if (isAutoType || isShowPopup || isDirectCopy) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      let shortcutType = 'auto_type';
      if (isShowPopup) {
        // If popup is already showing, toggle it off immediately
        if (isPopupVisible()) {
          hidePopup();
          return;
        }
        shortcutType = 'show_popup';
      } else if (isDirectCopy) {
        shortcutType = 'copy_answer';
      }

      chrome.runtime.sendMessage({
        action: 'shortcut_triggered',
        shortcutType: shortcutType
      }).catch(() => {});
    }
  }, true);

  // -------------------------------------------------------------
  // 2. Message Listener from Background Service Worker
  // -------------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract_context') {
      extractQuestionContext().then(context => {
        sendResponse({ context });
      });
      return true;
    }

    if (request.action === 'show_hud') {
      showMicroHUD(request.text, request.type);
      sendResponse({ success: true });
      return false;
    }

    if (request.action === 'execute_auto_type') {
      handleAutoTypeAction(request.parsed, request.raw, request.config, request.isWrongTarget, request.autoNext);
      sendResponse({ success: true });
      return false;
    }

    if (request.action === 'execute_show_popup') {
      hideMicroHUD();
      showAnswerPopup(request.parsed, request.raw);
      sendResponse({ success: true });
      return false;
    }

    if (request.action === 'execute_copy_answer') {
      handleCopyAction(request.parsed);
      sendResponse({ success: true });
      return false;
    }
  });

  // -------------------------------------------------------------
  // Helper: Send command to Main World script (main_world.js)
  // Uses CustomEvents — NO inline script injection, NO CSP issues.
  // -------------------------------------------------------------
  function sendToMainWorld(command, data) {
    return new Promise((resolve) => {
      const requestId = 'vsbpat_' + Math.random().toString(36).substring(2);

      const listener = (e) => {
        if (e.detail && e.detail.requestId === requestId) {
          window.removeEventListener('vsbpat_response', listener);
          resolve(e.detail.result);
        }
      };
      window.addEventListener('vsbpat_response', listener);

      // Send request to main_world.js
      window.dispatchEvent(new CustomEvent('vsbpat_request', {
        detail: { requestId, command, data: data || {} }
      }));

      // Timeout fallback: if main_world.js hasn't loaded yet
      setTimeout(() => {
        window.removeEventListener('vsbpat_response', listener);
        resolve(null);
      }, 2000);
    });
  }

  // -------------------------------------------------------------
  // 3. Question & Code Context Extraction
  // -------------------------------------------------------------

  // Force-remove copy/selection blocking on proctored exam pages
  function disableCopyProtection() {
    try {
      // Inject CSS to override user-select: none
      const styleId = 'vsbpat-unblock-select';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = '* { -webkit-user-select: text !important; user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; }';
        document.head.appendChild(style);
      }

      // Remove common JS copy-prevention event handlers
      const events = ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart'];
      events.forEach(evt => {
        document.addEventListener(evt, (e) => e.stopPropagation(), true);
      });

      // Remove oncopy/onselectstart/oncontextmenu attributes from body and key elements
      const protectedEls = [document.body, document.documentElement, ...document.querySelectorAll('[oncopy], [oncut], [onselectstart], [oncontextmenu], [ondragstart]')];
      protectedEls.forEach(el => {
        if (!el) return;
        el.removeAttribute('oncopy');
        el.removeAttribute('oncut');
        el.removeAttribute('onselectstart');
        el.removeAttribute('oncontextmenu');
        el.removeAttribute('ondragstart');
        el.style.userSelect = 'text';
        el.style.webkitUserSelect = 'text';
      });

      // Remove accesskeys to prevent shortcuts from navigating away
      document.querySelectorAll('[accesskey]').forEach(el => {
        el.removeAttribute('accesskey');
      });
    } catch (e) {}
  }

  // Run copy protection bypass immediately and on DOM changes
  disableCopyProtection();
  document.addEventListener('DOMContentLoaded', disableCopyProtection);

  // Deep text extractor: recursively walks DOM to grab all visible text,
  // even from elements with user-select: none or event blocking
  function deepExtractText(root, maxLen = 10000) {
    if (!root) return '';
    const parts = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName;
            // Skip hidden, script, style, and editor elements
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME'].includes(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_SKIP;
          }
          // Text node
          const text = node.textContent.trim();
          if (text.length > 0) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let totalLen = 0;
    while (walker.nextNode() && totalLen < maxLen) {
      const text = walker.currentNode.textContent.trim();
      if (text) {
        parts.push(text);
        totalLen += text.length;
      }
    }
    return parts.join(' ');
  }

  async function extractQuestionContext() {
    // Ensure copy protection is disabled first
    disableCopyProtection();

    // Step A: Active user text selection (highest priority)
    const selection = await getActiveSelection();
    if (selection && selection.length > 5) {
      return `SELECTED QUESTION / TEXT:\n${selection}`;
    }

    // Step B: Assessment portal question containers (broad list)
    const questionSelectors = [
      // Common / Generic
      '.question-container', '.question-content', '.question-text', '.q-text',
      '.problem-statement', '.problem-description', '.question-body',
      // LeetCode
      '[data-track-load="description_content"]', '.elfjS',
      // HackerRank / HackerEarth
      '.challenge-body-html', '.problem-body', '.challenge-text',
      // Jamneo / e-Yantra / proctored exam platforms
      '.coding-question', '.code-question', '.question-panel',
      '[class*="question-"]', '[class*="problem-"]', '[class*="Problem"]',
      '[class*="Question"]', '[class*="coding"]',
      // Assessment portals
      '.assessment-question', '.mcq-question', '.test-question',
      '#question-container', '#problem-statement', '.quiz-question',
      '[class*="question__"]', '[class*="problem__"]',
      '[class*="question-view"]', '[class*="ques-"]',
      // Generic fallbacks
      '.question', 'fieldset', '.card-body', '.panel-body',
      '.content-area', '.test-content', '.exam-content',
      '[role="main"]', 'main', 'article'
    ];

    let questionText = '';
    for (const sel of questionSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          // Use deepExtractText to bypass any copy protection
          const text = deepExtractText(el, 8000);
          if (text.length > 15) {
            questionText = text;
            break;
          }
          // Fallback to innerText
          const inner = el.innerText || el.textContent || '';
          if (inner.trim().length > 15) {
            questionText = inner.trim();
            break;
          }
        }
      } catch (e) {}
    }

    // Step B2: If no selector matched, try to find the largest visible text block
    if (!questionText) {
      const allBlocks = document.querySelectorAll('div, section, article, td, p, span, li');
      let bestText = '';
      let bestLen = 0;
      for (const el of allBlocks) {
        try {
          const text = (el.innerText || el.textContent || '').trim();
          // Look for elements with substantial text that look like a question
          if (text.length > 50 && text.length < 5000 && text.length > bestLen) {
            // Prefer elements that contain keywords like "problem", "write", "input", "output", "given"
            const lower = text.toLowerCase();
            if (lower.includes('problem') || lower.includes('write') || lower.includes('input') ||
                lower.includes('output') || lower.includes('given') || lower.includes('find') ||
                lower.includes('compute') || lower.includes('return') || lower.includes('example') ||
                lower.includes('constraint')) {
              bestText = text;
              bestLen = text.length;
            }
          }
        } catch (e) {}
      }
      if (bestText) {
        questionText = bestText;
      }
    }

    // Step C: Check for MCQ Options on screen
    const mcqOptions = extractMcqOptions();

    // Step D: Check for Code in Editor (Monaco, CodeMirror, Ace, Textarea)
    const editorCode = await getCodeFromEditor();

    // Build compound context
    let fullContext = '';
    if (questionText) {
      fullContext += `QUESTION:\n${questionText}\n\n`;
    }
    if (mcqOptions) {
      fullContext += `MCQ CHOICES / OPTIONS:\n${mcqOptions}\n\n`;
    }
    if (editorCode) {
      fullContext += `EXISTING EDITOR CODE / STARTER CODE:\n${editorCode}\n\n`;
    }

    // Fallback: If still empty, grab ALL visible text from the page body
    if (!fullContext.trim()) {
      const bodyText = deepExtractText(document.body, 10000);
      if (bodyText.length > 20) {
        fullContext = `PAGE ASSESSMENT CONTENT:\n${bodyText}`;
      } else {
        // Last resort: raw innerText from body
        const rawText = (document.body.innerText || document.body.textContent || '').slice(0, 10000);
        fullContext = `PAGE ASSESSMENT CONTENT:\n${rawText}`;
      }
    }

    return fullContext.trim();
  }

  async function getActiveSelection() {
    const mainWorldRes = await sendToMainWorld('getSelection');

    if (mainWorldRes) return mainWorldRes;
    // 3. Textarea / Input selection
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start !== undefined && end !== undefined && start !== end) {
        return active.value.substring(start, end);
      }
    }
    // 4. Standard window selection
    return window.getSelection()?.toString()?.trim() || '';
  }

  function extractMcqOptions() {
    const optionLabels = document.querySelectorAll(
      'label, .option, .choice, [role="radio"], .mcq-option, [class*="option-item"], [class*="choice-item"]'
    );
    if (optionLabels.length === 0) return '';

    const optionsList = [];
    optionLabels.forEach(el => {
      const txt = el.innerText?.trim();
      if (txt && txt.length > 0 && txt.length < 300) {
        optionsList.push(txt);
      }
    });

    if (optionsList.length >= 2) {
      return optionsList.slice(0, 8).join('\n');
    }
    return '';
  }

  async function getCodeFromEditor() {
    const mainWorldRes = await sendToMainWorld('getEditorCode');

    let detectedLang = mainWorldRes ? mainWorldRes.lang : '';
    if (!detectedLang) {
      // Fallback: Check LeetCode language selector buttons or tabs
      const langBtn = document.querySelector('[data-mode-id], button[id^="headlessui-listbox-button"], [data-cy="lang-select"], .ant-select-selection-selected-value, .lang-selector .active');
      if (langBtn && langBtn.innerText) {
        detectedLang = langBtn.innerText.trim();
      }
    }

    let codeToReturn = mainWorldRes && mainWorldRes.code ? mainWorldRes.code : '';
    if (!codeToReturn) {
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        codeToReturn = active.value || active.innerText || '';
      }
    }

    if (detectedLang) {
      return `REQUIRED LANGUAGE: ${detectedLang}\n\n${codeToReturn}`;
    }
    return codeToReturn;
  }

  function clickSaveAndNext() {
      const btnCandidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], .btn, [class*="btn"], [class*="button"]'));
      
      let nextBtn = null;
      for (const btn of btnCandidates) {
          const text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
          if (text === 'save & next' || text === 'save and next' || text === 'save & next >' || text.includes('save & next')) {
              nextBtn = btn; break;
          }
      }
      
      if (!nextBtn) {
          for (const btn of btnCandidates) {
              const text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
              if (text === 'next' || text === 'next >' || text.includes('next question')) {
                  nextBtn = btn; break;
              }
          }
      }
      
      if (nextBtn) {
          nextBtn.click();
          chrome.runtime.sendMessage({ action: 'auto_solve_next' });
      } else {
          showMicroHUD('⚠️ Could not find Next button', 'error');
          // Still send next message so loop doesn't stall if auto-advanced
          chrome.runtime.sendMessage({ action: 'auto_solve_next' });
      }
  }

  // -------------------------------------------------------------
  // 4. Action 1: Auto-Type & MCQ Selection
  // -------------------------------------------------------------
  async function handleAutoTypeAction(parsed, raw, config, isWrongTarget = false, autoNext = false) {
    hideMicroHUD();

    // CASE 1: MCQ Answer -> Automatically click the option on the page
    if (parsed.type === 'MCQ' && parsed.option) {
      const clicked = selectMcqOption(parsed.option, parsed.optionText, isWrongTarget);
      if (clicked) {
        showMicroHUD(`✓ Selected Option`, 'success');
        if (autoNext) {
          setTimeout(clickSaveAndNext, 1000);
        }
        return;
      }
    }

    // CASE 2: Code or Text Answer -> Type into editor
    const textToType = parsed.code || parsed.text || parsed.copyText || raw;
    if (!textToType) {
      showMicroHUD('⚠️ No code or answer to type', 'error');
      return;
    }

    const typingMode = config?.typingMode || 'instant';
    const typingSpeedMs = config?.typingSpeedMs || 15;

    const typedTarget = await insertTextIntoEditor(textToType, typingMode, typingSpeedMs);
    showMicroHUD(`✓ Typed into ${typedTarget}`, 'success');
  }

  function selectMcqOption(optionLetter, optionText, isWrongTarget = false) {
    const letter = optionLetter.toUpperCase().trim();
    const optTextClean = (optionText || '').toLowerCase().trim();

    const isNav = (el) => {
        if (!el) return false;
        
        // 1. Text-based rejection
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (['previous', 'prev', 'next', 'back', 'submit', 'finish', 'clear', 'review', 'save', 'mark', 'flag', 'next question', 'previous question'].includes(text)) return true;
        
        // 2. Class/ID-based rejection
        const id = (el.id || '').toLowerCase();
        const cls = (typeof el.className === 'string' ? el.className.toLowerCase() : '');
        
        const navKeywords = ['prev', 'next', 'back', 'pagination', 'palette', 'nav', 'foot', 'header', 'sidebar', 'menu', 'bookmark', 'flag'];
        for (const kw of navKeywords) {
            if (id.includes(kw) || cls.includes(kw)) return true;
        }

        // 3. Parent-based rejection (check up to 4 levels up for palette/nav containers)
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 4) {
            const pId = (parent.id || '').toLowerCase();
            const pCls = (typeof parent.className === 'string' ? parent.className.toLowerCase() : '');
            for (const kw of navKeywords) {
                if (pId.includes(kw) || pCls.includes(kw)) return true;
            }
            parent = parent.parentElement;
            depth++;
        }
        
        // 4. Reject generic number buttons (likely question grid) if they lack option-like classes
        if (/^\d+$/.test(text)) {
            const isOptionClass = cls.includes('option') || cls.includes('choice') || cls.includes('answer') || cls.includes('radio');
            if (!isOptionClass && (el.tagName === 'BUTTON' || el.tagName === 'LI' || el.tagName === 'A' || el.tagName === 'DIV')) {
                return true; 
            }
        }
        
        // 5. Reject single letters if they're generic buttons/links (section nav)
        if (/^[a-z]$/i.test(text)) {
            const isOptionClass = cls.includes('option') || cls.includes('choice') || cls.includes('answer') || cls.includes('radio');
            if (!isOptionClass && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
                return true;
            }
        }

        return false;
    };

    // Candidate elements that can be clicked
    let candidates = Array.from(document.querySelectorAll(
      'input[type="radio"], [role="radio"], label, button, .option, .choice, [class*="option"], [class*="choice"], .answer, [class*="answer"], tr, li'
    ));

    // Exclude navigation elements
    candidates = candidates.filter(el => !isNav(el));

    const normalize = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const optTextNorm = normalize(optTextClean);

    const finalizeSelection = (correctEl) => {
        if (!isWrongTarget) {
            clickAndHighlightOption(correctEl);
            return true;
        }
        
        // Find a wrong sibling or generic radio
        const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => !isNav(r));
        if (radios.length > 1) {
            const correctRadio = correctEl.tagName === 'INPUT' ? correctEl : correctEl.querySelector('input[type="radio"]');
            const wrongRadios = radios.filter(r => r !== correctRadio);
            if (wrongRadios.length > 0) {
                clickAndHighlightOption(wrongRadios[Math.floor(Math.random() * wrongRadios.length)]);
                return true;
            }
        }
        
        // Try candidates that have similar class
        if (correctEl.className && typeof correctEl.className === 'string') {
            const cls = correctEl.className.trim().split(/\s+/)[0];
            if (cls) {
                const siblings = Array.from(document.querySelectorAll('.' + cls)).filter(el => !isNav(el) && el !== correctEl);
                if (siblings.length > 0) {
                    clickAndHighlightOption(siblings[Math.floor(Math.random() * siblings.length)]);
                    return true;
                }
            }
        }

        // Just click correct if we can't find anything else
        clickAndHighlightOption(correctEl);
        return true;
    };

    // Pass 1: Look for exact letter match (e.g. "A", "A.", "A)", "Option A")
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim();
      const value = (el.value || '').trim();

      const matchesLetter = value.toUpperCase() === letter ||
        text === letter ||
        text.startsWith(letter + '.') ||
        text.startsWith(letter + ')') ||
        text.startsWith(letter + ' ') ||
        text.startsWith(letter + ':') ||
        text.startsWith(letter + ' -') ||
        text.startsWith('(' + letter + ')') ||
        text.startsWith('[' + letter + ']') ||
        text.toLowerCase().startsWith('option ' + letter.toLowerCase());

      if (matchesLetter) {
        return finalizeSelection(el);
      }
    }

    // Pass 2: Look for option text match if provided
    if (optTextNorm.length > 2) {
      let bestMatch = null;
      let bestScore = 0;

      for (const el of candidates) {
        const textRaw = (el.innerText || el.textContent || '').trim();
        if (textRaw.length === 0 || textRaw.length > 1000) continue;

        const textNorm = normalize(textRaw);

        if (textNorm === optTextNorm) {
          return finalizeSelection(el);
        }

        if (textNorm.includes(optTextNorm) || optTextNorm.includes(textNorm)) {
          let score = 1;
          const tagName = el.tagName.toLowerCase();
          if (tagName === 'label' || tagName === 'input' || tagName === 'button') score += 2;
          if (typeof el.className === 'string' && (el.className.toLowerCase().includes('option') || el.className.toLowerCase().includes('choice') || el.className.toLowerCase().includes('answer'))) score += 2;
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = el;
          }
        }
      }

      if (bestMatch) {
        return finalizeSelection(bestMatch);
      }
    }

    // Pass 3: Index based fallback
    const letterIdx = letter.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3
    if (letterIdx >= 0 && letterIdx <= 7) {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      if (radios.length >= 2 && radios.length <= 10 && letterIdx < radios.length) {
        return finalizeSelection(radios[letterIdx]);
      }
      
      const labels = Array.from(document.querySelectorAll('label')).filter(el => !isNav(el));
      if (labels.length >= 2 && labels.length <= 10 && letterIdx < labels.length) {
         return finalizeSelection(labels[letterIdx]);
      }
      
      const optionSelectors = ['.mcq-option', '.option', '.choice', '[role="radio"]', '.answer-option'];
      for (const sel of optionSelectors) {
          const els = Array.from(document.querySelectorAll(sel)).filter(el => !isNav(el));
          if (els.length >= 2 && els.length <= 10 && letterIdx < els.length) {
              return finalizeSelection(els[letterIdx]);
          }
      }
    }

    return false;
  }

  function clickAndHighlightOption(element) {
    let inputEl = null;
    if (element.tagName === 'INPUT') {
      inputEl = element;
    } else {
      inputEl = element.querySelector('input[type="radio"], input[type="checkbox"]');
    }

    // Try to trigger framework events on the container
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    if (inputEl) {
      inputEl.checked = true;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      
      // If we have a hidden input inside a label, clicking the element triggers it again,
      // which can uncheck checkboxes or toggle some custom radios off. We avoid calling element.click()
      // if we already explicitly clicked the input, UNLESS it's required by a specific framework.
      // But typically, calling input.click() is safer if we know it's a real input.
      inputEl.click();
    } else {
      element.click();
    }

    try {
      element.focus?.();
    } catch(e) {}

    // Subtle stealth highlight that fades
    const prevOutline = element.style.outline;
    const prevTransition = element.style.transition;
    element.style.transition = 'outline 0.2s ease';
    element.style.outline = '2px solid #10b981';
    setTimeout(() => {
      element.style.outline = prevOutline;
      element.style.transition = prevTransition;
    }, 2000);
  }

  async function insertTextIntoEditor(content, mode = 'instant', speedMs = 15) {
    const mainWorldRes = await sendToMainWorld('insertCode', { code: content });

    if (mainWorldRes) return mainWorldRes;

    // 4. Active Textarea or Input field
    let targetField = document.activeElement;
    if (!targetField || (targetField.tagName !== 'TEXTAREA' && targetField.tagName !== 'INPUT' && !targetField.isContentEditable)) {
      targetField = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
    }

    if (targetField) {
      if (mode === 'human' && targetField.tagName === 'TEXTAREA') {
        await typeHumanLike(targetField, content, speedMs);
        return 'Input Field (Human Simulated)';
      }

      if (targetField.isContentEditable) {
        targetField.innerText = content;
      } else {
        targetField.value = content;
      }

      // Dispatch full suite of input events so reactive forms (React/Angular/Vue) update
      targetField.dispatchEvent(new Event('input', { bubbles: true }));
      targetField.dispatchEvent(new Event('change', { bubbles: true }));
      targetField.focus();
      return 'Input Field';
    }

    // Fallback: Copy to clipboard if no input field exists
    await navigator.clipboard.writeText(content);
    return 'Clipboard (No editor found)';
  }

  async function typeHumanLike(field, text, speedMs = 15) {
    field.value = '';
    field.focus();

    for (let i = 0; i < text.length; i++) {
      field.value += text[i];
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text[i] }));
      await new Promise(r => setTimeout(r, speedMs));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // -------------------------------------------------------------
  // 5. Action 2: In-Page Floating Answer Popup (Shadow DOM)
  // -------------------------------------------------------------
  let shadowRoot = null;
  let popupHost = null;

  function ensureShadowContainer() {
    if (popupHost && shadowRoot) return shadowRoot;

    popupHost = document.createElement('div');
    popupHost.id = 'vsbpat-overlay-host';
    popupHost.style.cssText = 'all: initial !important; position: fixed !important; z-index: 2147483647 !important; top: 0; left: 0; pointer-events: none !important;';
    document.documentElement.appendChild(popupHost);

    shadowRoot = popupHost.attachShadow({ mode: 'closed' });
    return shadowRoot;
  }

  function isPopupVisible() {
    if (!shadowRoot) return false;
    const card = shadowRoot.getElementById('vsbpat-modal');
    return card && card.style.display !== 'none';
  }

  function hidePopup() {
    if (!shadowRoot) return;
    const card = shadowRoot.getElementById('vsbpat-modal');
    if (card) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-8px) scale(0.98)';
      setTimeout(() => {
        card.style.display = 'none';
      }, 200);
    }
  }

  function showAnswerPopup(parsed, rawText) {
    const root = ensureShadowContainer();
    let modal = root.getElementById('vsbpat-modal');

    // Build HTML content for answer
    let bodyHtml = '';
    if (parsed.type === 'MCQ') {
      bodyHtml = `
        <div class="mcq-box">
          <div class="mcq-badge">
            <span class="mcq-letter">${escapeHtml(parsed.option)}</span>
            <span class="mcq-text">${escapeHtml(parsed.optionText || 'Correct Option')}</span>
          </div>
          ${parsed.explanation ? `<div class="mcq-expl">${escapeHtml(parsed.explanation)}</div>` : ''}
        </div>
      `;
    } else if (parsed.type === 'CODE') {
      bodyHtml = `
        <div class="code-box">
          <div class="code-bar">
            <span class="code-tag">Solution Code</span>
            <button class="mini-copy-btn" id="btn-copy-code">Copy Code</button>
          </div>
          <pre class="code-content"><code>${escapeHtml(parsed.code)}</code></pre>
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="general-box">
          <div class="general-text">${escapeHtml(parsed.text || rawText)}</div>
        </div>
      `;
    }

    if (!modal) {
      const container = document.createElement('div');
      container.innerHTML = `
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          .vsbpat-card {
            position: fixed;
            top: 24px;
            right: 24px;
            width: 440px;
            max-width: calc(100vw - 48px);
            max-height: 85vh;
            background: rgba(15, 23, 42, 0.94);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            box-shadow: 0 10px 35px rgba(0, 0, 0, 0.5), 0 0 1px rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(16px);
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            font-size: 13px;
            display: flex;
            flex-direction: column;
            pointer-events: auto !important;
            transition: opacity 0.2s ease, transform 0.2s ease;
            opacity: 1;
            transform: translateY(0) scale(1);
            overflow: hidden;
            user-select: text;
          }
          .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            cursor: grab;
            user-select: none;
          }
          .card-header:active { cursor: grabbing; }
          .header-brand {
            display: flex;
            align-items: center;
            gap: 7px;
            font-weight: 600;
            font-size: 12px;
            color: #38bdf8;
            letter-spacing: 0.3px;
          }
          .header-brand .dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 8px #10b981;
          }
          .header-actions {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .h-btn {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.06);
            color: #94a3b8;
            border-radius: 6px;
            padding: 3px 7px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          .h-btn:hover {
            background: rgba(255, 255, 255, 0.16);
            color: #f1f5f9;
          }
          .card-body {
            padding: 14px;
            overflow-y: auto;
            max-height: calc(85vh - 90px);
          }
          /* MCQ styles */
          .mcq-box { display: flex; flex-direction: column; gap: 10px; }
          .mcq-badge {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(16, 185, 129, 0.12);
            border: 1px solid rgba(16, 185, 129, 0.3);
            padding: 10px 14px;
            border-radius: 10px;
          }
          .mcq-letter {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            background: #10b981;
            color: #022c22;
            font-weight: 800;
            font-size: 14px;
            border-radius: 50%;
            flex-shrink: 0;
          }
          .mcq-text {
            font-weight: 600;
            font-size: 14px;
            color: #a7f3d0;
            word-break: break-word;
          }
          .mcq-expl {
            color: #cbd5e1;
            font-size: 12px;
            line-height: 1.5;
            background: rgba(255, 255, 255, 0.02);
            padding: 10px;
            border-radius: 8px;
            white-space: pre-wrap;
          }
          /* Code styles */
          .code-box {
            background: #090d16;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            overflow: hidden;
          }
          .code-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(255, 255, 255, 0.04);
            padding: 6px 10px;
            font-size: 10px;
            color: #64748b;
          }
          .code-tag { font-weight: 700; text-transform: uppercase; color: #38bdf8; }
          .mini-copy-btn {
            background: rgba(56, 189, 248, 0.15);
            border: 1px solid rgba(56, 189, 248, 0.3);
            color: #7dd3fc;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            cursor: pointer;
          }
          .mini-copy-btn:hover { background: rgba(56, 189, 248, 0.3); }
          .code-content {
            padding: 12px;
            overflow-x: auto;
            font-family: "JetBrains Mono", Consolas, Monaco, monospace;
            font-size: 12px;
            line-height: 1.5;
            color: #e2e8f0;
            white-space: pre;
          }
          /* General styles */
          .general-text {
            line-height: 1.6;
            color: #e2e8f0;
            white-space: pre-wrap;
            word-break: break-word;
          }
          /* Card Footer */
          .card-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 14px;
            background: rgba(0, 0, 0, 0.2);
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            font-size: 11px;
          }
          .footer-actions { display: flex; gap: 6px; }
          .primary-action-btn {
            background: #2563eb;
            color: white;
            border: none;
            padding: 5px 10px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 11px;
            cursor: pointer;
            transition: background 0.15s ease;
          }
          .primary-action-btn:hover { background: #1d4ed8; }
          .secondary-action-btn {
            background: rgba(255, 255, 255, 0.08);
            color: #cbd5e1;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 5px 10px;
            border-radius: 6px;
            font-size: 11px;
            cursor: pointer;
          }
          .secondary-action-btn:hover { background: rgba(255, 255, 255, 0.14); }
          .shortcut-reminder { color: #64748b; font-size: 10px; }
        </style>
        <div class="vsbpat-card" id="vsbpat-modal">
          <div class="card-header" id="vsbpat-drag-handle">
            <div class="header-brand">
              <div class="dot"></div>
              <span>vsbpat AI Solver</span>
            </div>
            <div class="header-actions">
              <button class="h-btn" id="btn-opacity" title="Cycle Opacity">👁️ Opacity</button>
              <button class="h-btn" id="btn-close" title="Close (Esc)">✕</button>
            </div>
          </div>
          <div class="card-body" id="vsbpat-modal-body">
            ${bodyHtml}
          </div>
          <div class="card-footer">
            <span class="shortcut-reminder">Esc to close • Alt+A to type</span>
            <div class="footer-actions">
              <button class="secondary-action-btn" id="btn-copy-modal">Copy</button>
              <button class="primary-action-btn" id="btn-type-modal">Auto-Type</button>
            </div>
          </div>
        </div>
      `;
      root.appendChild(container);
      modal = root.getElementById('vsbpat-modal');

      // Make card draggable
      initDraggable(modal, root.getElementById('vsbpat-drag-handle'));

      // Event handlers
      root.getElementById('btn-close').onclick = (e) => {
        e.stopPropagation();
        hidePopup();
      };

      // Cycle opacity (100% -> 70% -> 40% -> 100%)
      const opacities = ['0.94', '0.65', '0.35'];
      let opIdx = 0;
      root.getElementById('btn-opacity').onclick = (e) => {
        e.stopPropagation();
        opIdx = (opIdx + 1) % opacities.length;
        modal.style.opacity = opacities[opIdx];
      };

      // Prevent clicks inside popup from blurring the main assessment window
      modal.addEventListener('mousedown', (e) => e.stopPropagation());
      modal.addEventListener('mouseup', (e) => e.stopPropagation());
      modal.addEventListener('click', (e) => e.stopPropagation());
    } else {
      // Update existing modal body
      root.getElementById('vsbpat-modal-body').innerHTML = bodyHtml;
      modal.style.display = 'flex';
      modal.style.opacity = '1';
      modal.style.transform = 'translateY(0) scale(1)';
    }

    // Bind action buttons
    const copyBtn = root.getElementById('btn-copy-modal');
    if (copyBtn) {
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        const textToCopy = parsed.code || parsed.text || parsed.copyText || rawText;
        navigator.clipboard.writeText(textToCopy);
        copyBtn.innerText = '✓ Copied!';
        setTimeout(() => { copyBtn.innerText = 'Copy'; }, 1500);
      };
    }

    const copyCodeBtn = root.getElementById('btn-copy-code');
    if (copyCodeBtn) {
      copyCodeBtn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(parsed.code || '');
        copyCodeBtn.innerText = '✓ Copied!';
        setTimeout(() => { copyCodeBtn.innerText = 'Copy Code'; }, 1500);
      };
    }

    const typeBtn = root.getElementById('btn-type-modal');
    if (typeBtn) {
      typeBtn.onclick = (e) => {
        e.stopPropagation();
        handleAutoTypeAction(parsed, rawText);
        hidePopup();
      };
    }
  }

  function initDraggable(element, handle) {
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      element.style.right = 'auto';
      element.style.left = initialLeft + 'px';
      element.style.top = initialTop + 'px';

      const onMouseMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        element.style.left = `${Math.max(10, initialLeft + dx)}px`;
        element.style.top = `${Math.max(10, initialTop + dy)}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // -------------------------------------------------------------
  // 6. Action 3: Copy Answer Directly
  // -------------------------------------------------------------
  async function handleCopyAction(parsed) {
    const textToCopy = parsed.code || parsed.copyText || parsed.text || '';
    if (!textToCopy) {
      showMicroHUD('⚠️ Nothing to copy', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      const label = parsed.type === 'MCQ' ? `✓ Copied ${parsed.copyText}` : '✓ Solution copied to clipboard';
      showMicroHUD(label, 'success');
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = textToCopy;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showMicroHUD('✓ Solution copied to clipboard', 'success');
    }
  }

  // -------------------------------------------------------------
  // 7. Micro HUD Indicator (Stealth Pill)
  // -------------------------------------------------------------
  let hudTimeout = null;

  function showMicroHUD(message, type = 'loading') {
    const root = ensureShadowContainer();
    let hud = root.getElementById('vsbpat-hud-pill');

    const isSuccess = type === 'success';
    const isError = type === 'error';
    const isWarning = type === 'warning';

    const borderCol = isSuccess ? '#10b981' : (isError ? '#ef4444' : (isWarning ? '#f59e0b' : 'rgba(255,255,255,0.12)'));
    const dotCol = isSuccess ? '#10b981' : (isError ? '#ef4444' : (isWarning ? '#f59e0b' : '#38bdf8'));

    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'vsbpat-hud-pill';
      hud.style.cssText = `
        position: fixed !important;
        top: 14px !important;
        right: 14px !important;
        z-index: 2147483647 !important;
        background: rgba(15, 23, 42, 0.94) !important;
        border: 1px solid ${borderCol} !important;
        color: #f1f5f9 !important;
        padding: 6px 14px !important;
        border-radius: 20px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 11.5px !important;
        font-weight: 500 !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4) !important;
        backdrop-filter: blur(8px) !important;
        transition: opacity 0.2s ease, transform 0.2s ease !important;
        opacity: 1 !important;
        transform: translateY(0) scale(1) !important;
        pointer-events: none !important;
        user-select: none !important;
      `;
      root.appendChild(hud);
    } else {
      hud.style.border = `1px solid ${borderCol}`;
      hud.style.opacity = '1';
      hud.style.transform = 'translateY(0) scale(1)';
      hud.style.display = 'flex';
    }

    hud.innerHTML = `
      <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${dotCol}; box-shadow:0 0 6px ${dotCol};"></span>
      <span>${escapeHtml(message)}</span>
    `;

    if (hudTimeout) clearTimeout(hudTimeout);

    // Auto-fade for success/error/warning
    if (type !== 'loading') {
      hudTimeout = setTimeout(() => {
        hideMicroHUD();
      }, 1800);
    }
  }

  function hideMicroHUD() {
    if (!shadowRoot) return;
    const hud = shadowRoot.getElementById('vsbpat-hud-pill');
    if (hud) {
      hud.style.opacity = '0';
      hud.style.transform = 'translateY(-6px) scale(0.97)';
      setTimeout(() => {
        hud.style.display = 'none';
      }, 220);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

})();
