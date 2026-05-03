const https = require('https');

const AIRTABLE_TOKEN = 'pataBCeGvhlN3N4Uq.cfa8a096a4b28fac19de4ea8006778cc5822fa610b9a2615cc144a4290e6a185';

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => resolve({ status: 500, body: JSON.stringify({ error: { message: e.message } }) }));
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{}' };

  const apiKey = (event.headers['x-api-key'] || '').trim();
  if (!apiKey.startsWith('sk-ant-')) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: { message: 'Clé API invalide' } }) };
  }

  let bodyObj = {};
  try { bodyObj = JSON.parse(event.body || '{}'); } catch(e) {}

  // Injecter le MCP Airtable dans la requête Claude
  const claudeBody = {
    model: bodyObj.model || 'claude-sonnet-4-5',
    max_tokens: bodyObj.max_tokens || 4000,
    system: bodyObj.system,
    messages: bodyObj.messages,
    mcp_servers: [
      {
        type: 'url',
        url: 'https://mcp.airtable.com/mcp',
        name: 'airtable',
        authorization_token: AIRTABLE_TOKEN
      }
    ]
  };

  // Nettoyer les champs undefined
  if (!claudeBody.system) delete claudeBody.system;

  const bodyStr = JSON.stringify(claudeBody);
  const result = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    },
    bodyStr
  );

  return { statusCode: result.status, headers: cors, body: result.body };
};
