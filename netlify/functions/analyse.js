const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
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

  const photosCtx = photoNames.length > 0
    ? '\n\nProduits identifiés depuis les captures du site doretdeplatineshop.com :\n'
      + photoNames.map((n, i) => `- Photo ${i+1}: ${n}`).join('\n')
    : '';

  const prompt = `Tu es un assistant pour D'or et de Platine (doretdeplatineshop.com), boutique de JuL gérée par Believe.
Tu as accès à la base Airtable (base ID: appouax19tnHJj0TD, table: tblGrm2yPn0ldTi01).
Les champs importants sont : Designation (fldba0MGx8lL3TQWS) et Réf Believe (fld02IfEMQb0zorrD).

Analyse ce message WhatsApp et pour chaque produit identifié, utilise l'outil Airtable search_records pour chercher le produit dans la table et récupérer sa Réf Believe exacte.${photosCtx}

ADRESSE : Si code postal seul → déduis la ville (13012→Marseille 12e, 75001→Paris 1er, 69001→Lyon 1er). Si ville seule → note que le CP manque.

ALERTES à signaler :
- Adresse incomplète (manque rue, CP, ville ou téléphone)
- Quantité manquante pour un article
- Taille manquante pour un article textile

Retourne UNIQUEMENT un JSON brut sans markdown :
{
  "products": [
    {"nom_original":"texte brut","nom_propre":"nom officiel Airtable","reference_believe":"REF trouvée ou N/A","quantite":1,"taille":"M ou N/A","statut":"trouve","source":"texte"}
  ],
  "destinataire": {"nom":"...","adresse":"adresse complète avec ville déduite","telephone":"..."},
  "alertes": [{"type":"warning","message":"..."}],
  "message_whatsapp": "Message WhatsApp complet avec *gras*, emojis, séparateurs ━━━, récapitulatif produits avec refs Believe, adresse, et demande de confirmation. Signale les infos manquantes. IMPORTANT : utilise toujours le tutoiement (tu, toi, ton, ta, tes) dans ce message."
}

Message à analyser :
${message}`;

  try {
    const claudeBody = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      mcp_servers: [{
        type: 'url',
        url: 'https://mcp.airtable.com/mcp',
        name: 'airtable',
        authorization_token: AIRTABLE_TOKEN
      }]
    });

    const res = await httpsPost('api.anthropic.com', '/v1/messages', {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(claudeBody),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    }, claudeBody);

    const data = JSON.parse(res.body);
    if (res.status !== 200) {
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: data.error?.message || 'Erreur Claude' }) };
    }

    // Extraire le texte final (après les appels MCP)
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const json = parseJSON(text);

    return { statusCode: 200, headers: CORS, body: JSON.stringify(json) };

  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

function parseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON dans la réponse');
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
