const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function claudePost(apiKey, body) {
  const s = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(s),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

function claudePostMcp(apiKey, body) {
  const s = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(s),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '{}' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Clé API invalide' }) };
  }

  const { message, photoNames = [] } = body;
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Message manquant' }) };

  const photos = photoNames.length > 0 ? '\nPhotos identifiées: ' + photoNames.join(', ') : '';

  // ── ÉTAPE 1 : Analyser le message (sans Airtable, prompt ultra-court) ────
  const step1Prompt = `Assistant D'or et de Platine. Analyse ce message WhatsApp.${photos}
CP seul→ville (13012=Marseille 12e,75001=Paris 1er,69001=Lyon 1er). Ville seule→note CP manquant.
Alertes: adresse incomplète, quantité/taille manquante (textile).
JSON UNIQUEMENT:
{"products":[{"nom_original":"","nom_propre":"","quantite":1,"taille":"","source":"texte"}],"destinataire":{"nom":"","adresse":"","telephone":""},"alertes":[{"type":"warning","message":""}]}
Message: ${message}`;

  let result;
  try {
    const r1 = await claudePost(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: step1Prompt }]
    });
    const d1 = JSON.parse(r1.body);
    if (r1.status !== 200) throw new Error(d1.error?.message || 'Erreur step1');
    const t1 = (d1.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    result = parseJSON(t1);
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Erreur analyse: ' + e.message }) };
  }

  // ── ÉTAPE 2 : Chercher les refs Believe pour chaque produit via MCP ──────
  if (result.products && result.products.length > 0) {
    for (const p of result.products) {
      const nom = (p.nom_propre || p.nom_original || '').trim();
      if (!nom) { p.reference_believe = 'N/A'; p.statut = 'introuvable'; continue; }

      // Appel Claude minimal avec MCP Airtable juste pour chercher la ref
      const searchPrompt = `Cherche dans Airtable (base appouax19tnHJj0TD, table tblGrm2yPn0ldTi01) le produit "${nom}".
Retourne UNIQUEMENT la Réf Believe (champ fld02IfEMQb0zorrD) du premier résultat trouvé, ou "N/A" si rien trouvé. Rien d'autre.`;

      try {
        const r2 = await claudePostMcp(apiKey, {
          model: 'claude-sonnet-4-5',
          max_tokens: 50,
          messages: [{ role: 'user', content: searchPrompt }],
          mcp_servers: [{
            type: 'url',
            url: 'https://mcp.airtable.com/mcp',
            name: 'airtable',
            authorization_token: AIRTABLE_TOKEN
          }]
        });
        const d2 = JSON.parse(r2.body);
        if (r2.status === 200) {
          const ref = (d2.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          p.reference_believe = ref && ref !== 'N/A' && ref.length < 30 ? ref : 'N/A';
          p.statut = p.reference_believe !== 'N/A' ? 'trouve' : 'introuvable';
        } else {
          p.reference_believe = 'N/A';
          p.statut = 'introuvable';
        }
      } catch(e) {
        p.reference_believe = 'N/A';
        p.statut = 'introuvable';
      }
    }
  }

  // ── ÉTAPE 3 : Générer le message WhatsApp (prompt court) ─────────────────
  const prodList = (result.products || []).map(p =>
    `- ${p.nom_propre || p.nom_original} | Réf: ${p.reference_believe || 'N/A'} | Qté: ${p.quantite || '?'} | Taille: ${p.taille || '?'}`
  ).join('\n');

  const d = result.destinataire || {};
  const alertesList = (result.alertes || []).map(a => `- ${a.message}`).join('\n');

  const step3Prompt = `Génère un message WhatsApp de confirmation de commande D'or et de Platine.
Tutoiement, *gras*, emojis, séparateurs ━━━.
Produits:\n${prodList}
Livraison: ${d.nom || '?'}, ${d.adresse || '?'}, ${d.telephone || '?'}
${alertesList ? 'Infos manquantes à signaler:\n' + alertesList : ''}
Retourne UNIQUEMENT le message WhatsApp, rien d'autre.`;

  try {
    const r3 = await claudePost(apiKey, {
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: step3Prompt }]
    });
    const d3 = JSON.parse(r3.body);
    if (r3.status === 200) {
      result.message_whatsapp = (d3.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    }
  } catch(e) {
    result.message_whatsapp = '';
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON');
  let str = clean.substring(s, e + 1);
  try { return JSON.parse(str); } catch(_) {
    str = str.replace(/,\s*$/, '');
    let ob = 0, ob2 = 0, ins = false, esc = false;
    for (const c of str) {
      if (esc) { esc = false; continue; }
      if (c === '\\' && ins) { esc = true; continue; }
      if (c === '"') { ins = !ins; continue; }
      if (!ins) {
        if (c === '{') ob++; else if (c === '}') ob--;
        if (c === '[') ob2++; else if (c === ']') ob2--;
      }
    }
    while (ob2 > 0) { str += ']'; ob2--; }
    while (ob > 0) { str += '}'; ob--; }
    return JSON.parse(str);
  }
}
