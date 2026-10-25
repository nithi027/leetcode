// vsbpat — Main World Script
// This runs in the MAIN world (has access to window.monaco, window.ace, CodeMirror etc.)
// Communicates with content.js (ISOLATED world) via CustomEvents.

(function () {
  if (window.__vsbpat_main_world_ready) return;
  window.__vsbpat_main_world_ready = true;

  // Listen for requests from content.js
  window.addEventListener('vsbpat_request', (e) => {
    const { requestId, command, data } = e.detail || {};
    if (!requestId || !command) return;

    let result = null;

    try {
      if (command === 'getEditorCode') {
        result = getEditorCode();
      } else if (command === 'getSelection') {
        result = getEditorSelection();
      } else if (command === 'insertCode') {
        result = insertCodeIntoEditor(data.code);
      }
    } catch (err) {
      result = null;
    }

    // Send response back to content.js
    window.dispatchEvent(new CustomEvent('vsbpat_response', {
      detail: { requestId, result }
    }));
  });

  // -----------------------------------------------
  // Get code + language from the active editor
  // -----------------------------------------------
  function getEditorCode() {
    // 1. Monaco Editor (LeetCode, HackerRank, etc.)
    if (window.monaco && window.monaco.editor) {
      const editors = window.monaco.editor.getEditors();
      if (editors && editors.length > 0) {
        const model = editors[0].getModel();
        if (model) {
          const lang = model.getLanguageId ? model.getLanguageId() : '';
          return { code: model.getValue() || '', lang: lang };
        }
      }
    }

    // 2. CodeMirror
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      return { code: cmEl.CodeMirror.getValue(), lang: '' };
    }

    // 3. Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace && window.ace.edit) {
      try {
        const editor = window.ace.edit(aceEl);
        const session = editor.getSession();
        const mode = session.getMode();
        let lang = '';
        if (mode && mode.$id) {
          lang = mode.$id.replace('ace/mode/', '');
        }
        return { code: editor.getValue(), lang: lang };
      } catch (e) {}
    }

    return null;
  }

  // -----------------------------------------------
  // Get selected text from the active editor
  // -----------------------------------------------
  function getEditorSelection() {
    // 1. Monaco
    if (window.monaco && window.monaco.editor) {
      const editors = window.monaco.editor.getEditors();
      if (editors && editors.length > 0) {
        const editor = editors[0];
        const sel = editor.getSelection();
        if (sel && !sel.isEmpty()) {
          const model = editor.getModel();
          return model ? model.getValueInRange(sel) : null;
        }
      }
    }

    // 2. CodeMirror
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror && cmEl.CodeMirror.somethingSelected()) {
      return cmEl.CodeMirror.getSelection();
    }

    // 3. Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace && window.ace.edit) {
      try {
        const editor = window.ace.edit(aceEl);
        const selectedText = editor.getSelectedText();
        if (selectedText) return selectedText;
      } catch (e) {}
    }

    return null;
  }

  // -----------------------------------------------
  // Insert/replace code in the active editor
  // -----------------------------------------------
  function insertCodeIntoEditor(code) {
    // 1. Monaco
    if (window.monaco && window.monaco.editor) {
      const editors = window.monaco.editor.getEditors();
      if (editors && editors.length > 0) {
        const editor = editors[0];
        const model = editor.getModel();
        if (model) {
          editor.executeEdits('vsbpat-type', [{
            range: model.getFullModelRange(),
            text: code
          }]);
          editor.focus();
          return 'Monaco Editor';
        }
      }
    }

    // 2. CodeMirror
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      cmEl.CodeMirror.setValue(code);
      cmEl.CodeMirror.focus();
      return 'CodeMirror Editor';
    }

    // 3. Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace && window.ace.edit) {
      try {
        const editor = window.ace.edit(aceEl);
        editor.setValue(code, 1);
        editor.focus();
        return 'Ace Editor';
      } catch (e) {}
    }

    return null;
  }
})();
