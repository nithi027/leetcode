// vsbpat — Settings Popup Logic

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const providerSelect = document.getElementById('providerSelect');
  const providerPill = document.getElementById('providerPill');
  const groqModelGroup = document.getElementById('groqModelGroup');
  const groqModelSelect = document.getElementById('groqModelSelect');
  const geminiModelGroup = document.getElementById('geminiModelGroup');
  const geminiModelSelect = document.getElementById('geminiModelSelect');

  const openrouterModelGroup = document.getElementById('openrouterModelGroup');
  const openrouterModelInput = document.getElementById('openrouterModelInput');
  const customUrlGroup = document.getElementById('customUrlGroup');
  const customUrlInput = document.getElementById('customUrlInput');
  const customModelInput = document.getElementById('customModelInput');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const apiKeyHelperLink = document.getElementById('apiKeyHelperLink');
  const toggleKeyVisBtn = document.getElementById('toggleKeyVisBtn');
  const testApiBtn = document.getElementById('testApiBtn');
  const testBtnText = document.getElementById('testBtnText');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const testFeedback = document.getElementById('testFeedback');
  const typingModeSelect = document.getElementById('typingModeSelect');
  const speedGroup = document.getElementById('speedGroup');
  const speedSlider = document.getElementById('speedSlider');
  const speedVal = document.getElementById('speedVal');
  const connectionBadge = document.getElementById('connectionBadge');
  const autoSolveTotal = document.getElementById('autoSolveTotal');
  const autoSolveWrong = document.getElementById('autoSolveWrong');

  const refreshGroqModelsBtn = document.getElementById('refreshGroqModelsBtn');
  const refreshGeminiModelsBtn = document.getElementById('refreshGeminiModelsBtn');

  // Load saved settings
  const config = await chrome.storage.local.get(null);

  if (config.provider) providerSelect.value = config.provider;
  if (config.apiKey) apiKeyInput.value = config.apiKey;

  // Filter out any legacy/deprecated models from storage
  const legacyGroq = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  if (config.groqModel && !legacyGroq.includes(config.groqModel)) {
    // If option exists in dropdown, select it
    if ([...groqModelSelect.options].some(o => o.value === config.groqModel)) {
      groqModelSelect.value = config.groqModel;
    } else {
      const opt = document.createElement('option');
      opt.value = config.groqModel;
      opt.innerText = config.groqModel;
      opt.selected = true;
      groqModelSelect.appendChild(opt);
    }
  } else {
    groqModelSelect.value = 'openai/gpt-oss-120b';
  }

  const legacyGemini = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-2.5-flash'];
  if (config.geminiModel && !legacyGemini.includes(config.geminiModel)) {
    if ([...geminiModelSelect.options].some(o => o.value === config.geminiModel)) {
      geminiModelSelect.value = config.geminiModel;
    } else {
      const opt = document.createElement('option');
      opt.value = config.geminiModel;
      opt.innerText = config.geminiModel;
      opt.selected = true;
      geminiModelSelect.appendChild(opt);
    }
  } else {
    geminiModelSelect.value = 'gemini-flash-latest';
  }

  if (config.openrouterModel) openrouterModelInput.value = config.openrouterModel;
  if (config.customUrl) customUrlInput.value = config.customUrl;
  if (config.customModel) customModelInput.value = config.customModel;
  if (config.typingMode) typingModeSelect.value = config.typingMode;
  if (config.typingSpeedMs) {
    speedSlider.value = config.typingSpeedMs;
    speedVal.innerText = `${config.typingSpeedMs} ms`;
  }
  if (config.autoSolveTotal !== undefined) autoSolveTotal.value = config.autoSolveTotal;
  if (config.autoSolveWrong !== undefined) autoSolveWrong.value = config.autoSolveWrong;

  updateProviderUI(providerSelect.value);
  updateTypingUI(typingModeSelect.value);

  // Auto-detect provider from API key prefix when typing or pasting
  apiKeyInput.addEventListener('input', () => {
    const key = apiKeyInput.value.trim();
    if (key.startsWith('gsk_') && providerSelect.value !== 'groq') {
      providerSelect.value = 'groq';
      updateProviderUI('groq');
      showFeedback('Detected Groq API key!', 'success');
      setTimeout(hideFeedback, 2000);
    } else if ((key.startsWith('AQ.') || key.startsWith('AIzaSy')) && providerSelect.value !== 'gemini') {
      providerSelect.value = 'gemini';
      updateProviderUI('gemini');
      showFeedback('Detected Google Gemini API key!', 'success');
      setTimeout(hideFeedback, 2000);
    } else if (key.startsWith('sk-or-') && providerSelect.value !== 'openrouter') {
      providerSelect.value = 'openrouter';
      updateProviderUI('openrouter');
      showFeedback('Detected OpenRouter API key!', 'success');
      setTimeout(hideFeedback, 2000);
    }
  });

  // Dynamic model refresh handlers
  if (refreshGroqModelsBtn) {
    refreshGroqModelsBtn.addEventListener('click', () => refreshModelsForProvider('groq', groqModelSelect, refreshGroqModelsBtn));
  }
  if (refreshGeminiModelsBtn) {
    refreshGeminiModelsBtn.addEventListener('click', () => refreshModelsForProvider('gemini', geminiModelSelect, refreshGeminiModelsBtn));
  }


  async function refreshModelsForProvider(provider, selectElement, btn) {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showFeedback('Please enter your API key first to fetch models.', 'error');
      return;
    }

    const prevText = btn.innerText;
    btn.innerText = '⏳ Loading...';
    btn.disabled = true;

    chrome.runtime.sendMessage({
      action: 'fetch_models',
      provider: provider,
      apiKey: key
    }, (resp) => {
      btn.innerText = prevText;
      btn.disabled = false;

      if (resp && resp.success && resp.models && resp.models.length > 0) {
        selectElement.innerHTML = '';
        resp.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.innerText = m;
          selectElement.appendChild(opt);
        });
        showFeedback(`✓ Fetched ${resp.models.length} active models from your account!`, 'success');
        updateBadgeStatus(true);
      } else {
        showFeedback(`⚠️ ${resp?.error || 'Could not fetch models'}`, 'error');
      }
    });
  }

  // Provider change listener
  providerSelect.addEventListener('change', () => {
    updateProviderUI(providerSelect.value);
  });

  // Typing mode change listener
  typingModeSelect.addEventListener('change', () => {
    updateTypingUI(typingModeSelect.value);
  });

  speedSlider.addEventListener('input', () => {
    speedVal.innerText = `${speedSlider.value} ms`;
  });

  // Toggle API Key visibility
  toggleKeyVisBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyVisBtn.innerText = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyVisBtn.innerText = '👁️';
    }
  });

  // Test API Connection
  testApiBtn.addEventListener('click', async () => {
    const currentConfig = collectConfig();

    if (!currentConfig.apiKey || currentConfig.apiKey.trim() === '') {
      showFeedback('Please enter an API key first.', 'error');
      return;
    }

    testBtnText.innerText = '⏳ Testing...';
    testApiBtn.disabled = true;
    hideFeedback();

    try {
      chrome.runtime.sendMessage({
        action: 'test_api_connection',
        config: currentConfig
      }, (response) => {
        testBtnText.innerText = '⚡ Test API';
        testApiBtn.disabled = false;

        if (response && response.success) {
          showFeedback('✓ Connected successfully to AI model!', 'success');
          updateBadgeStatus(true);
        } else {
          showFeedback(`⚠️ ${response?.error || 'Failed to connect'}`, 'error');
          updateBadgeStatus(false);
        }
      });
    } catch (e) {
      testBtnText.innerText = '⚡ Test API';
      testApiBtn.disabled = false;
      showFeedback(`⚠️ ${e.message}`, 'error');
      updateBadgeStatus(false);
    }
  });

  // Save Settings
  saveConfigBtn.addEventListener('click', async () => {
    const newConfig = collectConfig();
    await chrome.storage.local.set(newConfig);

    saveConfigBtn.innerText = '✓ Saved!';
    setTimeout(() => {
      saveConfigBtn.innerText = 'Save Settings';
    }, 1200);

    showFeedback('Settings saved successfully.', 'success');
  });

  // Helpers
  function updateProviderUI(provider) {
    groqModelGroup.classList.add('hidden');
    geminiModelGroup.classList.add('hidden');
    openrouterModelGroup.classList.add('hidden');
    customUrlGroup.classList.add('hidden');

    if (provider === 'groq') {
      groqModelGroup.classList.remove('hidden');
      providerPill.innerText = 'Groq Free';
      apiKeyHelperLink.href = 'https://console.groq.com/keys';
      apiKeyHelperLink.innerText = 'Get Free Groq Key ↗';
      apiKeyInput.placeholder = 'gsk_...';
    } else if (provider === 'gemini') {
      geminiModelGroup.classList.remove('hidden');
      providerPill.innerText = 'Google Gemini';
      apiKeyHelperLink.href = 'https://aistudio.google.com/apikey';
      apiKeyHelperLink.innerText = 'Get Free Gemini Key ↗';
      apiKeyInput.placeholder = 'AIzaSy... or AQ....';
    } else if (provider === 'openrouter') {
      openrouterModelGroup.classList.remove('hidden');
      providerPill.innerText = 'OpenRouter';
      apiKeyHelperLink.href = 'https://openrouter.ai/keys';
      apiKeyHelperLink.innerText = 'Get OpenRouter Key ↗';
      apiKeyInput.placeholder = 'sk-or-...';
    } else if (provider === 'custom') {
      customUrlGroup.classList.remove('hidden');
      providerPill.innerText = 'Custom Endpoint';
      apiKeyHelperLink.href = '#';
      apiKeyHelperLink.innerText = 'Local / Custom URL';
      apiKeyInput.placeholder = 'Optional API key';
    }
  }

  function updateTypingUI(mode) {
    if (mode === 'human') {
      speedGroup.classList.remove('hidden');
    } else {
      speedGroup.classList.add('hidden');
    }
  }

  function collectConfig() {
    return {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value.trim(),
      groqModel: groqModelSelect.value,
      geminiModel: geminiModelSelect.value,
      openrouterModel: openrouterModelInput.value.trim(),
      customUrl: customUrlInput.value.trim(),
      customModel: customModelInput.value.trim(),
      typingMode: typingModeSelect.value,
      typingSpeedMs: parseInt(speedSlider.value, 10) || 15,
      autoSolveTotal: parseInt(autoSolveTotal.value, 10) || 30,
      autoSolveWrong: parseInt(autoSolveWrong.value, 10) || 0
    };
  }

  function showFeedback(msg, type = 'success') {
    testFeedback.innerText = msg;
    testFeedback.className = `feedback-msg ${type}`;
    testFeedback.classList.remove('hidden');
  }

  function hideFeedback() {
    testFeedback.classList.add('hidden');
  }

  function updateBadgeStatus(connected) {
    const dot = connectionBadge.querySelector('.status-dot');
    const lbl = connectionBadge.querySelector('.status-label');
    if (connected) {
      dot.style.background = '#10b981';
      dot.style.boxShadow = '0 0 6px #10b981';
      lbl.innerText = 'Active';
    } else {
      dot.style.background = '#ef4444';
      dot.style.boxShadow = '0 0 6px #ef4444';
      lbl.innerText = 'Error';
    }
  }
});
