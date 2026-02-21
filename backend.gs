/**
 * Recording Companion - Google Drive Backup + AI Debrief + Integrations
 *
 * DEPLOYMENT:
 * 1. Go to script.google.com > New Project
 * 2. Paste this entire file
 * 3. Click Deploy > New Deployment > Web App
 * 4. Execute as: Me | Who has access: Anyone
 * 5. Copy the URL and paste it into the Recording Companion tool
 *
 * REQUIRED SCRIPT PROPERTIES:
 *   ANTHROPIC_API_KEY = your-api-key
 *
 * OPTIONAL:
 *   BRAVE_API_KEY       = for web search / guest prep (free at https://api.search.brave.com)
 *   SLACK_WEBHOOK_URL   = for posting session summaries to Slack
 *   CLICKUP_API_TOKEN   = for creating tasks from action items
 *   CLICKUP_LIST_ID     = target list for ClickUp tasks
 */

const FOLDER_NAME = 'Recording Companion Backups';

// ==================== ROUTING ====================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    switch (action) {
      case 'backup':       return respond(saveBackup(data.sessionName, data.sessionData));
      case 'restore':      return respond(loadBackup(data.sessionName));
      case 'list':         return respond(listBackups());
      case 'ping':         return respond(getPingStatus());
      case 'ai_debrief':   return respond(aiDebrief(data.sessionData));
      case 'ai_followup':  return respond(aiFollowUp(data.questionText, data.notes, data.sessionContext));
      case 'ai_guest_prep': return respond(aiGuestPrep(data.guestName, data.company, data.linkedinUrl, data.recordingType));
      case 'ai_chat':      return respond(aiChat(data.question, data.context, data.messages));
      case 'ai_coach':     return respond(aiCoach(data.sessionSnapshot));
      case 'ai_live_coach': return respond(aiLiveCoach(data.transcriptChunk, data.prospectContext, data.conversationSummary, data.gapProgress));
      case 'ai_deep_prep': return respond(aiDeepPrep(data.guestName, data.company, data.linkedinUrl, data.website, data.industry));
      case 'export_doc':   return respond(createGoogleDoc(data.sessionData));
      case 'slack_notify':  return respond(postToSlack(data.payload));
      case 'create_tasks': return respond(createClickUpTasks(data.tasks, data.listId));
      default: return respond({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return respond({ error: err.message });
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'restore') return respond(loadBackup(e.parameter.session));
    if (action === 'list')    return respond(listBackups());
    if (action === 'ping')    return respond(getPingStatus());
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getPingStatus() {
  var props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    folder: FOLDER_NAME,
    ai: !!props.getProperty('ANTHROPIC_API_KEY'),
    webSearch: !!props.getProperty('BRAVE_API_KEY'),
    slack: !!props.getProperty('SLACK_WEBHOOK_URL'),
    clickup: !!props.getProperty('CLICKUP_API_TOKEN'),
    clickupListId: props.getProperty('CLICKUP_LIST_ID') || null
  };
}

// ==================== DRIVE BACKUP ====================

function getOrCreateFolder() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function saveBackup(sessionName, sessionData) {
  var folder = getOrCreateFolder();
  var slug = (sessionName || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  var fileName = 'recording-' + slug + '.json';
  var content = JSON.stringify(sessionData, null, 2);

  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  }

  return { success: true, timestamp: new Date().toISOString(), session: sessionName, file: fileName };
}

function loadBackup(sessionSlug) {
  var folder = getOrCreateFolder();
  var fileName = 'recording-' + sessionSlug + '.json';
  var files = folder.getFilesByName(fileName);
  if (!files.hasNext()) return { error: 'No backup found for: ' + sessionSlug };
  return JSON.parse(files.next().getBlob().getDataAsString());
}

function listBackups() {
  var folder = getOrCreateFolder();
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().startsWith('recording-')) {
      list.push({
        name: f.getName().replace('recording-', '').replace('.json', ''),
        fileName: f.getName(),
        updated: f.getLastUpdated().toISOString(),
        size: f.getSize()
      });
    }
  }
  return list;
}

// ==================== WEB SEARCH (Brave) ====================

function webSearch(query, count) {
  var braveKey = PropertiesService.getScriptProperties().getProperty('BRAVE_API_KEY');
  if (!braveKey) return null;
  count = count || 5;
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + count + '&text_decorations=false',
      { method: 'get', headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }, muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (!data.web || !data.web.results) return null;
    return data.web.results.map(function(r) {
      return { title: r.title || '', url: r.url || '', description: (r.description || '').substring(0, 300) };
    });
  } catch (e) { return null; }
}

// ==================== AI DEBRIEF ====================

function aiDebrief(sessionData) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'AI not configured. Add ANTHROPIC_API_KEY in Script Properties.' };

  var recordingType = sessionData.recordingType || 'casestudy';
  var typeLabel = { casestudy: 'Case Study', podcast: 'Podcast', discovery: 'Discovery Call' }[recordingType] || 'Recording';

  var systemPrompt = 'You are a senior content strategist at a B2B marketing agency. You observed a ' + typeLabel + ' recording session.\n\n' +
    'Generate a comprehensive post-recording content package. Return ONLY valid JSON with this structure:\n' +
    '{\n  "summary": "3-paragraph narrative of what was covered, key themes, standout moments",\n' +
    '  "clips": [{"timestamp": "MM:SS", "title": "Short title", "reason": "Why this works as a clip", "platform": "Best platform"}],\n' +
    '  "socialPosts": {\n    "linkedin": "Full LinkedIn post (200-300 words, hook + story)",\n    "twitter": "Tweet thread (3-5 tweets, each under 280 chars, separated by \\n\\n)",\n    "instagram": "Instagram caption with hashtags"\n  },\n' +
    '  "blogOutline": {"title": "Blog post title", "sections": ["Section heading + description"]},\n' +
    '  "emailSnippet": "Newsletter paragraph summarizing the key insight",\n' +
    '  "pullQuotes": ["Direct quote from notes", "Quote 2", "Quote 3"],\n' +
    '  "actionItems": ["Next step 1", "Next step 2"],\n';

  if (recordingType === 'casestudy') {
    systemPrompt += '  "caseStudyDraft": {"challenge": "...", "solution": "...", "results": "...", "quote": "Best testimonial quote"},\n';
  }
  if (recordingType === 'discovery') {
    systemPrompt += '  "dealIntel": {"painPoints": ["Pain 1"], "budget": "Budget signals", "timeline": "Timeline signals", "nextSteps": "Recommended next action", "score": 1-10},\n';
  }

  systemPrompt += '  "followUpEmail": "Full thank-you email referencing specific things discussed"\n}\n\n' +
    'Rules: Pull quotes from actual notes. Reference real timestamps. Skip sparse questions. Social posts must feel human. Return ONLY valid JSON.';

  var questions = sessionData.questions || [];
  var ctx = 'TYPE: ' + typeLabel + '\nCOMPANY: ' + (sessionData.company || '') + '\nGUEST: ' + (sessionData.guestName || '') +
    (sessionData.guestCompany ? ' (' + sessionData.guestCompany + ')' : '') + '\nTRACK: ' + (sessionData.track || '') +
    '\nDURATION: ' + (sessionData.recordingLength || '00:00');

  if (sessionData.transcript) {
    ctx += '\n\nTRANSCRIPT:\n' + sessionData.transcript.substring(0, 6000);
  }

  ctx += '\n\nQUESTIONS AND NOTES:\n';
  questions.forEach(function(q, i) {
    ctx += '\n' + (i+1) + '. [' + (q.asked ? 'ASKED' : 'SKIPPED') + ']';
    if (q.timestamp) ctx += ' [' + q.timestamp + ']';
    ctx += ' ' + q.phase + ': ' + q.text;
    if (q.notes && q.notes.trim()) ctx += '\n   NOTES: ' + q.notes.trim();
  });

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-sonnet-4-6-20250514', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: ctx }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { error: 'API error: ' + result.error.message };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { var parsed = JSON.parse(text); parsed.success = true; return parsed; }
    catch (e) { return { error: 'Failed to parse AI response', raw: text.substring(0, 2000) }; }
  } catch (e) { return { error: 'Request failed: ' + e.message }; }
}

// ==================== AI FOLLOW-UP ====================

function aiFollowUp(questionText, notes, sessionContext) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'AI not configured.' };

  var systemPrompt = 'You are an interview coach watching a live session. Suggest ONE follow-up question that digs deeper.\n' +
    'Return JSON: {"followUp": "Question under 30 words", "why": "10-word reason"}\nReturn ONLY valid JSON.';
  var userPrompt = 'Question: ' + questionText + '\nNotes: ' + (notes || '(none)') + '\nContext: ' + (sessionContext || '').substring(0, 1000);

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { error: result.error.message };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { return JSON.parse(text); } catch (e) { return { followUp: text, why: '' }; }
  } catch (e) { return { error: e.message }; }
}

// ==================== AI GUEST PREP ====================

function aiGuestPrep(guestName, company, linkedinUrl, recordingType) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'AI not configured.' };
  var typeLabel = { casestudy: 'case study', podcast: 'podcast', discovery: 'discovery call' }[recordingType] || 'recording';

  var searchResults = webSearch(guestName + ' ' + (company || ''), 6);
  var webContext = '';
  var sources = [];
  if (searchResults && searchResults.length > 0) {
    sources = searchResults.map(function(r) { return { title: r.title, url: r.url }; });
    webContext = '\nWeb results:\n';
    searchResults.forEach(function(r, i) { webContext += (i+1) + '. ' + r.title + '\n   ' + r.description + '\n'; });
  }
  if (linkedinUrl) webContext += '\nLinkedIn: ' + linkedinUrl;

  var systemPrompt = 'Research assistant preparing a guest brief for a ' + typeLabel + '.\nReturn JSON:\n' +
    '{"bio": "2-3 sentence bio", "company": "1-2 sentences", "talkingPoints": ["Point 1", "Point 2", "Point 3"], "recentNews": "Recent news or null", "icebreaker": "Opening question based on research"}\nReturn ONLY valid JSON.';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: 'Guest: ' + guestName + '\nCompany: ' + (company || '') + webContext }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { error: result.error.message, sources: sources };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { var p = JSON.parse(text); p.sources = sources; p.success = true; return p; }
    catch (e) { return { bio: text, sources: sources, success: true }; }
  } catch (e) { return { error: e.message, sources: sources }; }
}

// ==================== AI REAL-TIME COACHING ====================

function aiCoach(sessionSnapshot) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { tips: [] };

  var systemPrompt = 'You are a real-time interview coach watching a live session. Analyze the current state and return coaching tips.\n\n' +
    'Return JSON: {"tips": [{"type": "warning|suggestion|praise", "icon": "emoji", "text": "Under 25 words"}], "score": 0-100, "momentum": "strong|steady|needs-attention"}\n\n' +
    'Scoring: questions asked % (40pts), note depth (30pts), timestamp usage (15pts), question variety (15pts).\n' +
    'Types: warning = address now, suggestion = opportunity, praise = doing well.\nMax 3 tips. Return ONLY valid JSON.';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: systemPrompt, messages: [{ role: 'user', content: JSON.stringify(sessionSnapshot) }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { tips: [], error: result.error.message };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { return JSON.parse(text); } catch (e) { return { tips: [{ type: 'suggestion', icon: '💡', text: text }], score: 50 }; }
  } catch (e) { return { tips: [], error: e.message }; }
}

// ==================== AI CHAT ====================

function aiChat(question, context, messages) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { response: 'AI not configured.' };

  var systemPrompt = 'You are a senior recording coach. Help interviewers get better answers, handle awkward moments, and extract maximum value.\nKeep answers concise (2-4 sentences). Be actionable.\n\nSession context:\n' + (context || '{}');
  var chatMessages = (messages || []).filter(function(m) { return m.role && m.content; }).map(function(m) { return { role: m.role, content: m.content }; });
  if (question) chatMessages.push({ role: 'user', content: question });

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: systemPrompt, messages: chatMessages.length > 0 ? chatMessages : [{ role: 'user', content: question || 'Help me.' }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { response: 'Error: ' + result.error.message };
    return { response: result.content[0].text };
  } catch (e) { return { response: 'Error: ' + e.message }; }
}

// ==================== AI LIVE COACH (Keenan Mode — Gap Selling) ====================

function aiLiveCoach(transcriptChunk, prospectContext, conversationSummary, gapProgress) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'AI not configured.' };

  var systemPrompt = 'You are Keenan, a world-class sales coach who wrote Gap Selling. You are watching a LIVE discovery call in real time via transcript.\n\n' +
    'Your job: analyze the conversation and coach the sales rep with suggested questions based on Gap Selling methodology.\n\n' +
    'GAP SELLING STAGES (track progress 0-100% for each):\n' +
    '1. Current State — How they do things today, metrics, team, process\n' +
    '2. Problem — What is broken, frustrating, costing them money\n' +
    '3. Impact — Financial/emotional/operational cost of the problem\n' +
    '4. Future State — What ideal looks like, measurable outcomes\n' +
    '5. Solution — How your product/service bridges the gap\n' +
    '6. Close — Decision process, timeline, commitment\n\n' +
    'RULES:\n' +
    '- The transcript captures BOTH sides of the conversation (rep and prospect)\n' +
    '- Push for $ impact and quantification whenever problems surface\n' +
    '- Use "when" not "if" in suggested questions (assumes the problem exists)\n' +
    '- Never suggest questions that have already been asked in the conversation\n' +
    '- Questions should feel natural and conversational, not scripted\n' +
    '- Maximum 3 suggested questions per analysis\n' +
    '- Priority: "high" = ask this now, "medium" = ask when opportunity arises\n\n' +
    'Also identify speakers in the transcript. Infer from context who is speaking:\n' +
    '- The rep asks questions, probes problems, and guides the conversation\n' +
    '- The prospect describes their situation, answers questions, shares pain points\n\n' +
    'Return ONLY valid JSON:\n' +
    '{\n' +
    '  "gapStage": "current_state|problem|impact|future_state|solution|close",\n' +
    '  "gapProgress": {"current_state": 0, "problem": 0, "impact": 0, "future_state": 0, "solution": 0, "close": 0},\n' +
    '  "suggestedQuestions": [{"q": "Question text", "why": "Why ask this now", "priority": "high|medium"}],\n' +
    '  "insight": "One sentence about what just happened in the conversation",\n' +
    '  "warning": "Alert if rep is making a mistake (null if none)",\n' +
    '  "momentum": "strong|building|stalling|losing",\n' +
    '  "speakerLabels": [{"lineIndex": 0, "speaker": "rep|prospect"}]\n' +
    '}';

  var userPrompt = '';
  if (prospectContext) userPrompt += 'PROSPECT CONTEXT:\n' + prospectContext.substring(0, 1500) + '\n\n';
  if (conversationSummary) userPrompt += 'CONVERSATION SO FAR:\n' + conversationSummary.substring(0, 2000) + '\n\n';
  if (gapProgress) userPrompt += 'CURRENT GAP PROGRESS:\n' + JSON.stringify(gapProgress) + '\n\n';
  userPrompt += 'LATEST TRANSCRIPT:\n' + (transcriptChunk || '').substring(0, 2000);

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-sonnet-4-6-20250514', max_tokens: 1200, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { error: result.error.message };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { var parsed = JSON.parse(text); parsed.success = true; return parsed; }
    catch (e) { return { error: 'Failed to parse response', raw: text.substring(0, 500) }; }
  } catch (e) { return { error: e.message }; }
}

// ==================== AI DEEP PREP (Enhanced Research) ====================

function aiDeepPrep(guestName, company, linkedinUrl, website, industry) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'AI not configured.' };

  // Run multiple searches for comprehensive research
  var searches = [];
  var allSources = [];

  // Search 1: Person profile
  var s1 = webSearch(guestName + ' ' + (company || ''), 5);
  if (s1) { searches.push('PERSON PROFILE:\n' + s1.map(function(r, i) { return (i+1) + '. ' + r.title + ' - ' + r.description; }).join('\n')); allSources = allSources.concat(s1.map(function(r) { return { title: r.title, url: r.url }; })); }

  // Search 2: Company info
  if (company) {
    var s2 = webSearch(company + ' ' + (industry || '') + ' revenue employees', 5);
    if (s2) { searches.push('COMPANY INFO:\n' + s2.map(function(r, i) { return (i+1) + '. ' + r.title + ' - ' + r.description; }).join('\n')); allSources = allSources.concat(s2.map(function(r) { return { title: r.title, url: r.url }; })); }
  }

  // Search 3: Pain signals and reviews
  if (company) {
    var s3 = webSearch(company + ' challenges problems reviews complaints', 4);
    if (s3) { searches.push('PAIN SIGNALS:\n' + s3.map(function(r, i) { return (i+1) + '. ' + r.title + ' - ' + r.description; }).join('\n')); allSources = allSources.concat(s3.map(function(r) { return { title: r.title, url: r.url }; })); }
  }

  // Search 4: Podcast appearances
  var s4 = webSearch(guestName + ' podcast interview guest', 4);
  if (s4) { searches.push('PODCAST APPEARANCES:\n' + s4.map(function(r, i) { return (i+1) + '. ' + r.title + ' - ' + r.description; }).join('\n')); allSources = allSources.concat(s4.map(function(r) { return { title: r.title, url: r.url }; })); }

  // Search 5: Competitors
  if (company && industry) {
    var s5 = webSearch(company + ' competitors alternatives ' + industry, 4);
    if (s5) { searches.push('COMPETITORS:\n' + s5.map(function(r, i) { return (i+1) + '. ' + r.title + ' - ' + r.description; }).join('\n')); allSources = allSources.concat(s5.map(function(r) { return { title: r.title, url: r.url }; })); }
  }

  var webContext = searches.join('\n\n');
  if (linkedinUrl) webContext += '\n\nLinkedIn: ' + linkedinUrl;
  if (website) webContext += '\nWebsite: ' + website;

  var systemPrompt = 'You are a senior sales researcher preparing a deep prospect brief for a discovery call.\n' +
    'Analyze ALL provided web research and extract maximum intelligence.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{\n' +
    '  "bio": "2-3 sentence bio of the person",\n' +
    '  "companyOverview": "What the company does, positioning, value prop",\n' +
    '  "estimatedRevenue": "Revenue range estimate with reasoning (e.g. $5-10M based on...)",\n' +
    '  "teamSize": "Estimated team size",\n' +
    '  "recentNews": "Recent developments, launches, changes (null if none)",\n' +
    '  "podcastAppearances": ["Title of podcast 1", "Title of podcast 2"],\n' +
    '  "painSignals": ["Specific pain point or challenge 1", "Pain 2", "Pain 3"],\n' +
    '  "competitorContext": "Key competitors and how prospect might differentiate",\n' +
    '  "suggestedAngles": ["Discovery angle 1 - why this matters", "Angle 2"],\n' +
    '  "icebreaker": "Natural opening line referencing something specific from research",\n' +
    '  "sources": "Handled separately"\n' +
    '}\n\nBe specific. Reference actual facts from the research. Do not make things up.';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-sonnet-4-6-20250514', max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: 'Research target: ' + guestName + '\nCompany: ' + (company || 'Unknown') + '\nIndustry: ' + (industry || 'Unknown') + '\n\n' + webContext }] }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(resp.getContentText());
    if (result.error) return { error: result.error.message, sources: allSources };
    var text = result.content[0].text.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try {
      var parsed = JSON.parse(text);
      parsed.sources = allSources;
      parsed.success = true;
      return parsed;
    } catch (e) { return { bio: text, sources: allSources, success: true }; }
  } catch (e) { return { error: e.message, sources: allSources }; }
}

// ==================== GOOGLE DOCS EXPORT ====================

function createGoogleDoc(sessionData) {
  try {
    var typeLabel = { casestudy: 'Case Study', podcast: 'Podcast', discovery: 'Discovery Call' }[sessionData.recordingType] || 'Recording';
    var title = typeLabel + ' Notes - ' + (sessionData.guestName || 'Guest') + ' (' + (sessionData.company || '') + ') - ' + new Date().toLocaleDateString();
    var doc = DocumentApp.create(title);
    var body = doc.getBody();

    // Header
    body.appendParagraph(sessionData.company + ' x ' + sessionData.guestName).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph(typeLabel + ' | ' + (sessionData.track || '') + ' | ' + (sessionData.recordingLength || '') + ' | ' + new Date().toLocaleDateString());
    body.appendHorizontalRule();

    // Questions and Notes
    body.appendParagraph('Session Notes').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var lastPhase = '';
    (sessionData.questions || []).forEach(function(q) {
      if (q.phase !== lastPhase) {
        body.appendParagraph(q.phase).setHeading(DocumentApp.ParagraphHeading.HEADING3);
        lastPhase = q.phase;
      }
      var p = body.appendParagraph((q.asked ? '✅ ' : '⬜ ') + q.text);
      p.setBold(true);
      if (q.timestamp) body.appendParagraph('Timestamp: ' + q.timestamp).editAsText().setForegroundColor('#7c3aed');
      if (q.notes && q.notes.trim()) {
        var note = body.appendParagraph(q.notes.trim());
        note.setItalic(true);
        note.editAsText().setForegroundColor('#666666');
      }
    });

    // AI Debrief
    if (sessionData.debriefData) {
      var d = sessionData.debriefData;
      body.appendHorizontalRule();
      body.appendParagraph('AI-Generated Content').setHeading(DocumentApp.ParagraphHeading.HEADING2);

      if (d.summary) {
        body.appendParagraph('Summary').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        body.appendParagraph(d.summary);
      }
      if (d.actionItems && d.actionItems.length) {
        body.appendParagraph('Action Items').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        d.actionItems.forEach(function(a) { body.appendListItem(a); });
      }
      if (d.pullQuotes && d.pullQuotes.length) {
        body.appendParagraph('Key Quotes').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        d.pullQuotes.forEach(function(q) {
          var quote = body.appendParagraph('"' + q + '"');
          quote.setItalic(true);
        });
      }
      if (d.socialPosts) {
        body.appendParagraph('Social Media Drafts').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        if (d.socialPosts.linkedin) {
          body.appendParagraph('LinkedIn:').setBold(true);
          body.appendParagraph(d.socialPosts.linkedin);
        }
        if (d.socialPosts.twitter) {
          body.appendParagraph('Twitter/X:').setBold(true);
          body.appendParagraph(d.socialPosts.twitter);
        }
      }
      if (d.caseStudyDraft) {
        body.appendParagraph('Case Study Draft').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        body.appendParagraph('Challenge: ' + (d.caseStudyDraft.challenge || ''));
        body.appendParagraph('Solution: ' + (d.caseStudyDraft.solution || ''));
        body.appendParagraph('Results: ' + (d.caseStudyDraft.results || ''));
        if (d.caseStudyDraft.quote) {
          var cq = body.appendParagraph('"' + d.caseStudyDraft.quote + '"');
          cq.setItalic(true);
        }
      }
      if (d.followUpEmail) {
        body.appendParagraph('Follow-up Email Draft').setHeading(DocumentApp.ParagraphHeading.HEADING3);
        body.appendParagraph(d.followUpEmail);
      }
    }

    // Move to backup folder
    var folder = getOrCreateFolder();
    var file = DriveApp.getFileById(doc.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);

    return { success: true, docId: doc.getId(), docUrl: doc.getUrl(), title: title };
  } catch (e) {
    return { error: 'Failed to create doc: ' + e.message };
  }
}

// ==================== SLACK INTEGRATION ====================

function postToSlack(payload) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) return { error: 'SLACK_WEBHOOK_URL not configured in Script Properties.' };

  // Build Slack Block Kit message
  var blocks = [];

  // Header
  blocks.push({ type: 'header', text: { type: 'plain_text', text: (payload.typeEmoji || '🎬') + ' ' + (payload.typeLabel || 'Recording') + ' Complete', emoji: true } });

  // Guest info
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Guest:* ' + (payload.guestName || 'Unknown') + (payload.guestCompany ? ' (' + payload.guestCompany + ')' : '') + '\n*Company:* ' + (payload.company || '') + '\n*Duration:* ' + (payload.duration || '00:00') + ' | *Questions Asked:* ' + (payload.questionsAsked || 0) + '/' + (payload.questionsTotal || 0) } });

  blocks.push({ type: 'divider' });

  // Action items
  if (payload.actionItems && payload.actionItems.length > 0) {
    var actionText = '*Action Items:*\n';
    payload.actionItems.slice(0, 5).forEach(function(a) { actionText += '• ' + a + '\n'; });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: actionText } });
  }

  // Pull quotes
  if (payload.pullQuotes && payload.pullQuotes.length > 0) {
    var quoteText = '*Key Quotes:*\n';
    payload.pullQuotes.slice(0, 2).forEach(function(q) { quoteText += '> _"' + q + '"_\n'; });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: quoteText } });
  }

  // Links
  if (payload.docUrl) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '<' + payload.docUrl + '|View Google Doc>' } });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted by Recording Companion | Dopamine Digital' }] });

  try {
    var resp = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({ blocks: blocks }),
      muteHttpExceptions: true
    });
    return { success: resp.getResponseCode() === 200 };
  } catch (e) { return { error: e.message }; }
}

// ==================== CLICKUP INTEGRATION ====================

function createClickUpTasks(tasks, listId) {
  var props = PropertiesService.getScriptProperties();
  var apiToken = props.getProperty('CLICKUP_API_TOKEN');
  if (!apiToken) return { error: 'CLICKUP_API_TOKEN not configured.' };
  listId = listId || props.getProperty('CLICKUP_LIST_ID');
  if (!listId) return { error: 'No ClickUp list ID provided.' };

  var results = [];
  (tasks || []).forEach(function(task) {
    try {
      var resp = UrlFetchApp.fetch('https://api.clickup.com/api/v2/list/' + listId + '/task', {
        method: 'post',
        headers: { 'Authorization': apiToken, 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          name: task.name,
          description: task.description || '',
          priority: task.priority || 3,
          tags: task.tags || []
        }),
        muteHttpExceptions: true
      });
      var result = JSON.parse(resp.getContentText());
      if (result.id) {
        results.push({ success: true, id: result.id, name: task.name, url: result.url });
      } else {
        results.push({ success: false, name: task.name, error: result.err || 'Unknown error' });
      }
    } catch (e) {
      results.push({ success: false, name: task.name, error: e.message });
    }
  });

  return { success: true, tasks: results };
}
