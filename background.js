// vsbpat — Background Service Worker
// Direct AI API integration with Groq, Gemini, OpenRouter, and Custom endpoints.
// Zero login required, zero notifications, zero tab switching.

const DEFAULT_CONFIG = {
  provider: 'groq', // 'groq' | 'gemini' | 'openrouter' | 'custom'
  apiKey: '',
  groqModel: 'openai/gpt-oss-120b',
  geminiModel: 'gemini-flash-latest',
  openrouterModel: 'google/gemini-2.0-flash-exp:free',
  customUrl: 'http://localhost:11434/v1',
  customModel: 'llama3',
  typingMode: 'instant', // 'instant' | 'human'
  typingSpeedMs: 15,
  antiBlurShield: true
};

let isBusy = false;
let autoSolveState = {
  active: false,
  total: 0,
  current: 0,
  plan: [],
  tabId: null
};

// Initialize default storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  const toSet = {};
  for (const [key, val] of Object.entries(DEFAULT_CONFIG)) {
    if (existing[key] === undefined) toSet[key] = val;
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
});

// Chrome Command Listener (manifest shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  if (command === 'auto_type') {
    handleShortcutAction(activeTab.id, 'auto_type');
  } else if (command === 'show_in_page_popup') {
    handleShortcutAction(activeTab.id, 'show_popup');
  } else if (command === 'copy_answer') {
    handleShortcutAction(activeTab.id, 'copy_answer');
  } else if (command === 'auto_solve') {
    startAutoSolve(activeTab.id);
  }
});

// Content Script & Popup Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Shortcut triggered from in-page capture listener
  if (request.action === 'shortcut_triggered') {
    const tabId = sender?.tab?.id;
    if (tabId) {
      if (request.shortcutType === 'auto_solve') {
        startAutoSolve(tabId);
      } else {
        handleShortcutAction(tabId, request.shortcutType);
      }
    }
    sendResponse({ received: true });
    return false;
  }

  // Handle auto-solve next iteration trigger
  if (request.action === 'auto_solve_next') {
    if (autoSolveState.active) {
      autoSolveState.current++;
      // Wait a short time for page to fully transition/render the next question
      setTimeout(() => runAutoSolveStep(), 2500);
    }
    sendResponse({ received: true });
    return false;
  }

  // Test API connection from popup
  if (request.action === 'test_api_connection') {
    testApiConnection(request.config)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  // Fetch available models from provider
  if (request.action === 'fetch_models') {
    fetchAvailableModels(request.provider, request.apiKey)
      .then(models => sendResponse({ success: true, models }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Get current config
  if (request.action === 'get_config') {
    chrome.storage.local.get(null).then(cfg => sendResponse(cfg));
    return true;
  }
});

// -------------------------------------------------------------
// Core Shortcut Handler
// -------------------------------------------------------------
async function startAutoSolve(tabId) {
  if (autoSolveState.active) {
    // Toggle off
    autoSolveState.active = false;
    await sendTabMessage(tabId, { action: 'show_hud', text: '🛑 Auto-Solver Stopped', type: 'warning' });
    return;
  }

  const config = await chrome.storage.local.get(null);
  const total = parseInt(config.autoSolveTotal) || 30;
  const wrongCount = parseInt(config.autoSolveWrong) || 0;

  // Generate shuffled correct/wrong array
  const plan = Array(total).fill(true).fill(false, 0, wrongCount);
  for (let i = plan.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [plan[i], plan[j]] = [plan[j], plan[i]];
  }

  autoSolveState = {
    active: true,
    total: total,
    current: 0,
    plan: plan,
    tabId: tabId
  };

  runAutoSolveStep();
}

async function runAutoSolveStep() {
  if (!autoSolveState.active) return;
  const tabId = autoSolveState.tabId;
  const current = autoSolveState.current;

  if (current >= autoSolveState.total) {
    autoSolveState.active = false;
    await sendTabMessage(tabId, { action: 'show_hud', text: '✅ Auto-Solver Completed!', type: 'success' });
    return;
  }

  const isCorrectTarget = autoSolveState.plan[current];

  try {
    const config = await chrome.storage.local.get(null);

    await sendTabMessage(tabId, {
      action: 'show_hud',
      text: `🤖 Solving Q${current + 1}/${autoSolveState.total}... (${isCorrectTarget ? 'Target: Correct' : 'Target: Wrong'})`,
      type: 'loading'
    });

    const contextRes = await sendTabMessage(tabId, { action: 'extract_context' });
    if (!contextRes || !contextRes.context || contextRes.context.trim().length === 0) {
      throw new Error("Could not find question. Stopping.");
    }

    const aiResponse = await queryAI(contextRes.context, config);
    const parsed = parseAIOutput(aiResponse);

    await sendTabMessage(tabId, {
      action: 'execute_auto_type',
      parsed: parsed,
      raw: aiResponse,
      config: config,
      isWrongTarget: !isCorrectTarget,
      autoNext: true
    });

  } catch (err) {
    console.error(err);
    autoSolveState.active = false;
    await sendTabMessage(tabId, { action: 'show_hud', text: `⚠️ Auto-Solve Error: ${err.message}`, type: 'error' });
  }
}

// -------------------------------------------------------------
// Core Shortcut Handler
// -------------------------------------------------------------
async function handleShortcutAction(tabId, actionType) {
  if (isBusy) {
    await sendTabMessage(tabId, { action: 'show_hud', text: '⚡ Already processing...', type: 'warning' });
    return;
  }

  try {
    isBusy = true;
    const config = await chrome.storage.local.get(null);

    // Validate API key
    if (!config.apiKey || config.apiKey.trim() === '') {
      await sendTabMessage(tabId, {
        action: 'show_hud',
        text: '⚠️ Please set your API Key in vsbpat extension options',
        type: 'error'
      });
      return;
    }

    // Show on-screen subtle loading HUD
    const hudLabels = {
      auto_type: '⚡ Reading & Auto-typing...',
      show_popup: '⚡ Solving question...',
      copy_answer: '⚡ Reading & Copying...'
    };
    await sendTabMessage(tabId, {
      action: 'show_hud',
      text: hudLabels[actionType] || '⚡ Solving...',
      type: 'loading'
    });

    // Extract page context from active tab
    const contextRes = await sendTabMessage(tabId, { action: 'extract_context' });
    if (!contextRes || !contextRes.context || contextRes.context.trim().length === 0) {
      await sendTabMessage(tabId, {
        action: 'show_hud',
        text: '⚠️ Could not find question. Highlight text or click editor.',
        type: 'error'
      });
      return;
    }

    // Call AI Model
    const aiResponse = await queryAI(contextRes.context, config);

    // Parse AI Response
    const parsed = parseAIOutput(aiResponse);

    // Dispatch appropriate action
    if (actionType === 'auto_type') {
      await sendTabMessage(tabId, {
        action: 'execute_auto_type',
        parsed: parsed,
        raw: aiResponse,
        config: config
      });
    } else if (actionType === 'show_popup') {
      await sendTabMessage(tabId, {
        action: 'execute_show_popup',
        parsed: parsed,
        raw: aiResponse
      });
    } else if (actionType === 'copy_answer') {
      await sendTabMessage(tabId, {
        action: 'execute_copy_answer',
        parsed: parsed,
        raw: aiResponse
      });
    }
  } catch (err) {
    console.error('vsbpat solve error:', err);
    await sendTabMessage(tabId, {
      action: 'show_hud',
      text: `⚠️ ${err.message || 'Error processing request'}`,
      type: 'error'
    });
  } finally {
    isBusy = false;
  }
}

// -------------------------------------------------------------
// AI API Dispatcher
// -------------------------------------------------------------
async function queryAI(promptText, config) {
  const provider = config.provider || 'groq';
  const apiKey = (config.apiKey || '').trim();

  const systemInstruction = `You are an elite, highly precise technical assessment assistant solving questions on online platforms (MCQs, coding challenges, algorithms, technical questions).
Rules:
1. If this is a Multiple Choice Question (MCQ):
   First line MUST be in format:
   OPTION: [Letter, e.g. A, B, C, D]
   TEXT: [Exact option text or content]
   EXPLANATION: [1-2 concise sentence explanation]
2. If this is a Programming / Coding problem:
   - YOU MUST WRITE THE SOLUTION STRICTLY AND ONLY IN JAVA.
   - Output ONLY the complete, correct, optimal Java solution code in standard markdown code blocks (e.g. \`\`\`java ... \`\`\`).
   - Do NOT include long introductory or concluding text. Return only the working Java code solution ready to execute.
   - Completely IGNORE any old starter code or method signatures provided in Python, C++, or any other language. Always write the full solution in Java.
3. If this is a short question or fill-in-the-blank:
   - Provide the exact direct answer first, followed by a brief reason.
Be extremely accurate and concise.`;

  if (provider === 'groq') {
    return await callGroqAPI(promptText, systemInstruction, apiKey, config.groqModel || 'openai/gpt-oss-120b');
  } else if (provider === 'gemini') {
    return await callGeminiAPI(promptText, systemInstruction, apiKey, config.geminiModel || 'gemini-flash-latest');
  } else if (provider === 'nvidia') {
    return await callNvidiaAPI(promptText, systemInstruction, apiKey, config.nvidiaModel || 'meta/llama-3.1-405b-instruct');
  } else if (provider === 'openrouter') {
    return await callOpenRouterAPI(promptText, systemInstruction, apiKey, config.openrouterModel || 'google/gemini-2.0-flash-exp:free');
  } else if (provider === 'custom') {
    return await callCustomOpenAICompatible(promptText, systemInstruction, apiKey, config.customUrl, config.customModel);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

// 1. Groq API Call (Ultra-fast)
async function callGroqAPI(prompt, system, apiKey, model) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  const selectedModel = model || 'openai/gpt-oss-120b';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Groq API Error (${res.status})`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

// 2. Google Gemini API Call (Gemini Flash)
async function callGeminiAPI(prompt, system, apiKey, model) {
  const modelName = model || 'gemini-flash-latest';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: system }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 3000
      }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API Error (${res.status})`);
  }
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return parts.map(p => p.text).join('\n') || '';
}

// 2.5 NVIDIA NIM API Call (Free Llama 3.1 405B)
async function callNvidiaAPI(prompt, system, apiKey, model) {
  const endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'meta/llama-3.1-405b-instruct',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `NVIDIA API Error (${res.status})`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

// Fetch live available models for an API key
async function fetchAvailableModels(provider, apiKey) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Please enter an API key first.');
  }

  if (provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Failed to fetch Groq models');
    
    // Filter out audio/guard models
    const ignoreList = ['whisper', 'orpheus', 'guard', 'allam'];
    const models = (data.data || [])
      .map(m => m.id)
      .filter(id => !ignoreList.some(ign => id.toLowerCase().includes(ign)));

    // Prioritize top coding models
    const priority = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'groq/compound-mini', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b'];
    models.sort((a, b) => {
      const idxA = priority.indexOf(a);
      const idxB = priority.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
    return models;
  }

  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Failed to fetch Gemini models');

    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(name => !name.includes('tts') && !name.includes('clip') && !name.includes('robotics') && !name.includes('banana'));

    // Prioritize top flash models
    const priority = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];
    models.sort((a, b) => {
      const idxA = priority.indexOf(a);
      const idxB = priority.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
    return models;
  }

  if (provider === 'nvidia') {
    const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Failed to fetch NVIDIA models');
    
    const models = (data.data || []).map(m => m.id);
    const priority = ['meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'];
    models.sort((a, b) => {
      const idxA = priority.indexOf(a);
      const idxB = priority.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
    return models;
  }

  return [];
}

// 3. OpenRouter API Call (Free Models)
async function callOpenRouterAPI(prompt, system, apiKey, model) {
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://vsbpat-extension.local',
      'X-Title': 'vsbpat-assessment-solver'
    },
    body: JSON.stringify({
      model: model || 'google/gemini-2.0-flash-exp:free',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenRouter API Error (${res.status})`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

// 4. Custom OpenAI-compatible API Call
async function callCustomOpenAICompatible(prompt, system, apiKey, customUrl, model) {
  const baseUrl = (customUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'llama3',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 3000
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Custom API Error (${res.status})`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

// -------------------------------------------------------------
// Test API Connection
// -------------------------------------------------------------
async function testApiConnection(cfg) {
  try {
    const testPrompt = 'Hello, reply with only the word: OK';
    const res = await queryAI(testPrompt, cfg);
    if (res && res.length > 0) {
      return { success: true, message: 'Connected successfully!' };
    }
    return { success: false, error: 'Empty response from model.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------
// Output Parser (Extracts MCQ, Code, or Text)
// -------------------------------------------------------------
function parseAIOutput(rawText) {
  if (!rawText) return { type: 'UNKNOWN', cleanCode: '', raw: '' };
  const text = rawText.trim();

  // 1. Detect MCQ
  const optionMatch = text.match(/^OPTION:\s*[\*\_]*([A-Ea-e])[\*\_]*/im) ||
                      text.match(/(?:correct\s+)?(?:option|choice|answer)\s*[:\-]?\s*[\*\_]*([A-Ea-e])[\*\_]*/i) ||
                      text.match(/^[\*\_]*([A-Ea-e])[\.\)]\s*(.*)/im);

  const textMatch = text.match(/^TEXT:\s*(.*)$/im);
  const explMatch = text.match(/^EXPLANATION:\s*([\s\S]*)$/im);

  if (optionMatch) {
    const letter = optionMatch[1].toUpperCase();
    const optText = textMatch ? textMatch[1].trim() : (optionMatch[2] ? optionMatch[2].trim() : '');
    const expl = explMatch ? explMatch[1].trim() : text;
    return {
      type: 'MCQ',
      option: letter,
      optionText: optText,
      explanation: expl,
      copyText: optText ? `Option ${letter}: ${optText}` : `Option ${letter}`,
      raw: text
    };
  }

  // 2. Detect Code Block
  const codeBlockRegex = /```(?:[a-zA-Z0-9_\-#+]*)\r?\n([\s\S]*?)```/g;
  const matches = [...text.matchAll(codeBlockRegex)];

  if (matches.length > 0) {
    // Extract primary code block
    const pureCode = matches.map(m => m[1].trim()).join('\n\n');
    return {
      type: 'CODE',
      code: pureCode,
      copyText: pureCode,
      raw: text
    };
  }

  // 3. General Plain Text
  return {
    type: 'GENERAL',
    text: text,
    copyText: text,
    raw: text
  };
}

// -------------------------------------------------------------
// Helper to safely send tab messages
// -------------------------------------------------------------
async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // If content script is not yet initialized, try injecting it dynamically
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err2) {
      console.warn('Could not communicate with tab:', err2.message);
      return null;
    }
  }
}
