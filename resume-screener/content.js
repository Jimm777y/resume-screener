if (typeof window.__resumeScreenerLoaded === 'undefined') {
  window.__resumeScreenerLoaded = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractResume') {
      try {
        sendResponse({ success: true, data: extractCandidates() });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
  });
}

function extractCandidates() {
  // Try to detect multiple candidate cards (search results / list pages)
  const multiSelectors = [
    '.geek-item', '.resume-item', '.candidate-item',
    '[class*="geekItem"]', '[class*="resumeItem"]',
    '[class*="candidateItem"]', '[class*="resume-item"]',
    '[class*="candidate-item"]', '[class*="CandidateItem"]',
  ];

  for (const sel of multiSelectors) {
    const items = Array.from(document.querySelectorAll(sel))
      .filter(el => el.innerText.trim().length > 80);

    if (items.length >= 2) {
      return {
        type: 'multi',
        candidates: items.slice(0, 6).map(el => ({
          name: pickName(el),
          content: cleanText(el.innerText, 2500),
        })),
      };
    }
  }

  // Single resume page fallback
  return {
    type: 'single',
    candidates: [{
      name: pickName(document.body),
      content: extractSingleResume(),
    }],
  };
}

function extractSingleResume() {
  const resumeSelectors = [
    '.resume-detail-wrap', '.resume-detail', '.candidate-resume',
    '.resume-content', '.geek-resume',
    '[class*="resumeDetail"]', '[class*="resume-detail"]', '[class*="ResumeDetail"]',
  ];

  const noiseSelectors = [
    'header', 'nav', 'footer',
    '.header', '.nav', '.footer',
    '[class*="header"]', '[class*="nav"]', '[class*="footer"]',
    '[class*="toolbar"]', '[class*="action-bar"]',
    'script', 'style',
  ];

  let mainEl = null;
  for (const sel of resumeSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 100) { mainEl = el; break; }
  }

  if (!mainEl) {
    const candidates = Array.from(
      document.querySelectorAll('main, article, [role="main"], .main, #main, .content, #content')
    ).sort((a, b) => b.innerText.length - a.innerText.length);
    mainEl = candidates[0] || document.body;
  }

  const clone = mainEl.cloneNode(true);
  noiseSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));

  return cleanText(clone.innerText, 6000);
}

function pickName(el) {
  const selectors = ['.name', '.candidate-name', '[class*="userName"]', '[class*="geekName"]', 'h1', 'h2'];
  for (const sel of selectors) {
    const nameEl = el.querySelector ? el.querySelector(sel) : null;
    if (nameEl) {
      const t = nameEl.textContent.trim();
      if (t && t.length < 20) return t;
    }
  }
  return '';
}

function cleanText(text, maxLen) {
  return (text || '')
    .replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim()
    .substring(0, maxLen);
}
