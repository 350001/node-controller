// ============================================================
//  node-controller - Production Stable
//  Direct cancel via GitHub API
//  GH_TOKEN is written via updateGithubTokenSecret on addNode
//  Scheduling uses node list order, no scheduler:last
// ============================================================

import * as sealedbox from 'tweetnacl-sealedbox-js';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const USER_AGENT = 'node-controller/1.0';
const textEncoder = new TextEncoder();
const MAX_CONCURRENT = 5;

// ---------- Utils ----------
function encryptWithPublicKey(plaintext, publicKeyBase64) {
  const publicKey = decodeBase64(publicKeyBase64);
  const message = textEncoder.encode(plaintext);
  const sealed = sealedbox.seal(message, publicKey);
  return encodeBase64(sealed);
}

function isValidSecretName(name) {
  return /^[a-zA-Z0-9_]+$/.test(name) && !name.toUpperCase().startsWith('GITHUB_');
}

function getBearerToken(request) {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === '') {
      delete result[key];
      continue;
    }
    result[key] = value;
  }
  return result;
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const authToken = getBearerToken(request);

    if (method === 'POST' && path === '/nodes') {
      if (!authToken) return json({ error: 'Missing Authorization header' }, 401);
      try {
        const body = await request.json();
        return addNode(authToken, body, env);
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (method === 'PATCH' && path.startsWith('/nodes/')) {
      const id = path.slice(7);
      if (!id) return json({ error: 'Missing node id' }, 400);
      if (!authToken) return json({ error: 'Missing Authorization header' }, 401);
      try {
        const body = await request.json();
        return updateNode(id, authToken, body, env);
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (method === 'DELETE' && path.startsWith('/nodes/')) {
      const id = path.slice(7);
      if (!id) return json({ error: 'Missing node id' }, 400);
      if (!authToken) return json({ error: 'Missing Authorization header' }, 401);
      const cleanup = url.searchParams.get('cleanup') === 'true';
      return deleteNode(id, authToken, cleanup, env);
    }

    if (method === 'POST' && path === '/task/done') {
      if (!authToken) return json({ error: 'Missing Authorization header' }, 401);
      try {
        const body = await request.json();
        const { node } = body;
        if (!node) return json({ error: 'Missing node id' }, 400);
        return handleTaskDone(node, authToken, env);
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (method === 'POST' && path === '/node/online') {
      if (!authToken) return json({ error: 'Missing Authorization header' }, 401);
      try {
        const body = await request.json();
        const { node, run_id } = body;
        if (!node) return json({ error: 'Missing node id' }, 400);
        if (!run_id) return json({ error: 'Missing run_id' }, 400);
        return handleNodeOnline(node, run_id, authToken, env);
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
    }

    if (method === 'GET' && path === '/nodes') {
      if (!authToken || authToken !== env.ADMIN_KEY) {
        return json({ error: 'Unauthorized' }, 401);
      }
      return listNodes(env);
    }

    if (method === 'POST' && path === '/scheduler/reset') {
      if (!authToken || authToken !== env.ADMIN_KEY) {
        return json({ error: 'Unauthorized' }, 401);
      }
      // 只重置 running，不再有 last
      await env.NODE_KV.delete('scheduler:running');
      return json({ success: true, message: 'Scheduler reset' });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ---------- 取消 GitHub Actions 运行 ----------
async function cancelWorkflowRun(owner, repo, runId, token) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': USER_AGENT,
        }
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Failed to cancel run ${runId}: ${res.status} - ${errText}`);
      return false;
    }
    console.log(`✅ Cancelled run ${runId} for ${owner}/${repo}`);
    return true;
  } catch (e) {
    console.warn(`Failed to cancel run ${runId}: ${e.message}`);
    return false;
  }
}

// ---------- 处理节点上线通知 ----------
async function handleNodeOnline(nodeId, runId, authToken, env) {
  const node = await env.NODE_KV.get(`node:${nodeId}`, 'json');
  if (!node) return json({ error: `Node ${nodeId} not found` }, 404);
  if (node.token !== authToken) return json({ error: 'Invalid token' }, 401);

  const runningData = await env.NODE_KV.get('scheduler:running', 'json');

  if (runningData && runningData.node !== nodeId) {
    const oldNode = await env.NODE_KV.get(`node:${runningData.node}`, 'json');
    if (oldNode && oldNode.enabled !== false) {
      console.log(`🔔 New node ${nodeId} online, cancelling old node ${runningData.node} (run ${runningData.run_id})`);
      await cancelWorkflowRun(oldNode.owner, oldNode.repo, runningData.run_id, oldNode.token);
    }
  }

  await env.NODE_KV.put('scheduler:running', JSON.stringify({
    node: nodeId,
    run_id: runId,
    started: Date.now()
  }));

  return json({ ok: true, message: `Node ${nodeId} online (run ${runId}), old node ${runningData?.node || 'none'} cancelled` });
}

// ---------- 触发节点 ----------
async function triggerNode(nodeId, env) {
  const node = await env.NODE_KV.get(`node:${nodeId}`, 'json');
  if (!node) return { success: false, error: 'Node not found' };

  const { owner, repo, workflow, token, branch = 'main' } = node;
  const payload = {
    ref: branch,
    inputs: {}
  };

  try {
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify(payload)
      }
    );
    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      return { success: false, error: `GitHub API ${dispatchRes.status}: ${errText}` };
    }
    return { success: true, status: 'triggered' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---------- 任务完成（简化版，无 scheduler:last） ----------
async function handleTaskDone(nodeId, authToken, env) {
  const node = await env.NODE_KV.get(`node:${nodeId}`, 'json');
  if (!node) return json({ error: `Node ${nodeId} not found` }, 404);
  if (node.token !== authToken) return json({ error: 'Invalid token' }, 401);

  const allIds = await env.NODE_KV.get('nodes', 'json') || [];
  if (allIds.length === 0) return json({ ok: false, message: 'No nodes registered' }, 200);

  const currentIdx = allIds.indexOf(nodeId);
  if (currentIdx === -1) return json({ ok: false, message: 'Current node not in list' }, 200);

  let lastError = null;
  for (let i = 1; i <= allIds.length; i++) {
    const idx = (currentIdx + i) % allIds.length;
    const id = allIds[idx];
    const n = await env.NODE_KV.get(`node:${id}`, 'json');
    if (!n || n.enabled === false) continue;

    const result = await triggerNode(id, env);
    if (result.success) {
      return json({ ok: true, triggered: id, status: result.status });
    } else {
      lastError = result.error;
      console.warn(`Failed to trigger ${id}: ${lastError}`);
    }
  }

  return json({ ok: false, error: `All nodes failed, last error: ${lastError}` }, 500);
}

// ---------- 获取公钥 ----------
async function getPublicKey(owner, repo, token) {
  const pubKeyRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': USER_AGENT,
      }
    }
  );
  if (!pubKeyRes.ok) {
    const errText = await pubKeyRes.text();
    throw new Error(`Failed to get public key: ${pubKeyRes.status} - ${errText}`);
  }
  const data = await pubKeyRes.json();
  return { key: data.key, keyId: data.key_id };
}

// ---------- 批量上传 Secrets ----------
async function uploadSecretsConcurrently(owner, repo, token, secrets, pubKey, keyId) {
  const errors = [];
  for (let i = 0; i < secrets.length; i += MAX_CONCURRENT) {
    const batch = secrets.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async ({ name, value }) => {
        try {
          const encrypted = encryptWithPublicKey(value, pubKey);
          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId })
            }
          );
          if (!res.ok) {
            const errText = await res.text();
            return `Failed to set secret ${name}: ${res.status} - ${errText}`;
          }
          return null;
        } catch (e) {
          return `Failed to set secret ${name}: ${e.message}`;
        }
      })
    );
    for (const err of results) {
      if (err) errors.push(err);
    }
  }
  return errors;
}

// ---------- 批量删除 Secrets ----------
async function deleteSecretsConcurrently(owner, repo, token, names) {
  const uniqueNames = [...new Set(names)];
  const errors = [];

  for (let i = 0; i < uniqueNames.length; i += MAX_CONCURRENT) {
    const batch = uniqueNames.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async (name) => {
        try {
          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': USER_AGENT,
              }
            }
          );
          if (!res.ok && res.status !== 404) {
            const errText = await res.text();
            return `Failed to delete secret ${name}: ${res.status} - ${errText}`;
          }
          return null;
        } catch (e) {
          return `Failed to delete secret ${name}: ${e.message}`;
        }
      })
    );
    for (const err of results) {
      if (err) errors.push(err);
    }
  }
  return errors;
}

// ---------- 设置 CONTROLLER_URL ----------
async function ensureControllerVariable(owner, repo, token, controllerUrl) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/variables/CONTROLLER_URL`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ value: controllerUrl });

  const getRes = await fetch(url, { method: 'GET', headers });
  if (getRes.ok) {
    const patchRes = await fetch(url, { method: 'PATCH', headers, body });
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return `Failed to update CONTROLLER_URL: ${patchRes.status} - ${errText}`;
    }
    return null;
  }
  if (getRes.status === 404) {
    const postRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
      { method: 'POST', headers, body: JSON.stringify({ name: 'CONTROLLER_URL', value: controllerUrl }) }
    );
    if (!postRes.ok) {
      const errText = await postRes.text();
      return `Failed to create CONTROLLER_URL: ${postRes.status} - ${errText}`;
    }
    return null;
  }
  const errText = await getRes.text();
  return `Failed to check CONTROLLER_URL: ${getRes.status} - ${errText}`;
}

// ---------- 更新 GH_TOKEN ----------
async function updateGithubTokenSecret(owner, repo, token, newToken) {
  try {
    const { key: pubKey, keyId } = await getPublicKey(owner, repo, token);
    const encrypted = encryptWithPublicKey(newToken, pubKey);
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/GH_TOKEN`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId })
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `Failed to update GH_TOKEN: ${res.status} - ${errText}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---------- syncSecrets ----------
async function syncSecrets(owner, repo, token, oldConfig, deltaConfig, pubKey, keyId) {
  const errors = [];
  const toSet = [];
  const toDelete = [];

  function scheduleSecret(name, value, oldValue) {
    // GH_TOKEN is handled separately via updateGithubTokenSecret
    if (name === 'GH_TOKEN') {
      errors.push('GH_TOKEN can only be updated via the token field');
      return;
    }
    if (!isValidSecretName(name)) {
      errors.push(`Invalid secret name: ${name}`);
      return;
    }
    if (value === null || value === undefined || value === '') {
      if (oldValue !== undefined && oldValue !== null && oldValue !== '') {
        toDelete.push(name);
      }
      return;
    }
    if (oldValue === value) return;
    toSet.push({ name, value: String(value) });
  }

  if ('TUNNEL_TOKEN' in (deltaConfig || {})) {
    scheduleSecret('TUNNEL_TOKEN', deltaConfig.TUNNEL_TOKEN, oldConfig?.TUNNEL_TOKEN);
  }

  for (const [key, value] of Object.entries(deltaConfig || {})) {
    if (key === 'TUNNEL_TOKEN') continue;
    scheduleSecret(key, value, oldConfig?.[key]);
  }

  const [uploadErrors, deleteErrors] = await Promise.all([
    toSet.length > 0 ? uploadSecretsConcurrently(owner, repo, token, toSet, pubKey, keyId) : [],
    toDelete.length > 0 ? deleteSecretsConcurrently(owner, repo, token, toDelete) : [],
  ]);

  errors.push(...uploadErrors, ...deleteErrors);
  return errors;
}

// ---------- setupRepositoryConfig ----------
async function setupRepositoryConfig(owner, repo, token, oldConfig, deltaConfig, env) {
  const controllerUrl = env.CONTROLLER_URL;
  const errors = [];

  const varError = await ensureControllerVariable(owner, repo, token, controllerUrl);
  if (varError) errors.push(varError);

  let pubKey, keyId;
  try {
    const result = await getPublicKey(owner, repo, token);
    pubKey = result.key;
    keyId = result.keyId;
  } catch (e) {
    errors.push(e.message);
    return { success: false, error: errors.join('; ') };
  }

  const secretErrors = await syncSecrets(owner, repo, token, oldConfig, deltaConfig, pubKey, keyId);
  errors.push(...secretErrors);

  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }
  return { success: true };
}

// ---------- addNode ----------
async function addNode(authToken, body, env) {
  const { owner, repo, workflow, branch, enabled, config } = body;
  const token = authToken;

  if (!owner || !repo || !workflow || !token) {
    return json({ error: 'Missing required fields: owner, repo, workflow' }, 400);
  }
  if (!config?.TUNNEL_TOKEN) {
    return json({ error: 'Missing required field: TUNNEL_TOKEN in config' }, 400);
  }
  if (config?.GH_TOKEN) {
    return json({ error: 'GH_TOKEN cannot be inside config, use Authorization token' }, 400);
  }

  const id = `${owner}/${repo}`;
  const node = {
    owner, repo, workflow, token,
    branch: branch || 'main',
    enabled: enabled !== false,
    config: config || {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // 1. 写入普通 Secrets 和 Variables
  const result = await setupRepositoryConfig(owner, repo, token, {}, config, env);
  if (!result.success) {
    return json({ error: `GitHub API setup failed: ${result.error}` }, 403);
  }

  // 2. 显式写入 GH_TOKEN
  const ghResult = await updateGithubTokenSecret(owner, repo, token, token);
  if (!ghResult.success) {
    return json({ error: `Failed to update GH_TOKEN: ${ghResult.error}` }, 403);
  }

  await env.NODE_KV.put(`node:${id}`, JSON.stringify(node));
  let list = await env.NODE_KV.get('nodes', 'json') || [];
  if (!list.includes(id)) {
    list.push(id);
    await env.NODE_KV.put('nodes', JSON.stringify(list));
  }

  const { token: _, ...safeNode } = node;
  return json({ success: true, node: { id, ...safeNode } });
}

// ---------- updateNode ----------
async function updateNode(id, authToken, body, env) {
  const node = await env.NODE_KV.get(`node:${id}`, 'json');
  if (!node) return json({ error: 'Node not found' }, 404);

  let githubToken = null;
  let tokenChanged = false;

  if (authToken === node.token) {
    githubToken = authToken;
    tokenChanged = false;
  } else {
    try {
      await getPublicKey(node.owner, node.repo, authToken);
      githubToken = authToken;
      tokenChanged = true;
    } catch (e) {
      try {
        await getPublicKey(node.owner, node.repo, node.token);
        githubToken = node.token;
      } catch (e2) {
        return json({ error: 'Invalid token' }, 401);
      }
    }
  }

  const oldConfig = node.config || {};
  const newConfig = body.config !== undefined
    ? deepMerge(oldConfig, body.config)
    : oldConfig;

  if (tokenChanged) {
    const result = await updateGithubTokenSecret(node.owner, node.repo, githubToken, githubToken);
    if (!result.success) {
      return json({ error: `Failed to update GH_TOKEN: ${result.error}` }, 403);
    }
  }

  if (body.config !== undefined) {
    const result = await setupRepositoryConfig(
      node.owner,
      node.repo,
      githubToken,
      oldConfig,
      body.config,
      env
    );
    if (!result.success) {
      return json({ error: `GitHub API setup failed: ${result.error}` }, 403);
    }
  }

  const updatedNode = {
    ...node,
    workflow: body.workflow !== undefined ? body.workflow : node.workflow,
    token: tokenChanged ? githubToken : node.token,
    branch: body.branch !== undefined ? body.branch : node.branch,
    enabled: body.enabled !== undefined ? body.enabled : node.enabled,
    config: newConfig,
    updatedAt: Date.now(),
  };

  await env.NODE_KV.put(`node:${id}`, JSON.stringify(updatedNode));

  const { token, ...safeNode } = updatedNode;
  return json({ success: true, node: { id, ...safeNode } });
}

// ---------- deleteNode ----------
async function deleteNode(id, authToken, cleanup, env) {
  const node = await env.NODE_KV.get(`node:${id}`, 'json');
  if (!node) return json({ error: 'Node not found' }, 404);
  if (node.token !== authToken) return json({ error: 'Invalid token' }, 401);

  if (cleanup) {
    const allSecrets = [...new Set(['GH_TOKEN', 'TUNNEL_TOKEN', ...Object.keys(node.config || {})])];
    const deleteErrors = await deleteSecretsConcurrently(node.owner, node.repo, node.token, allSecrets);
    if (deleteErrors.length > 0) {
      console.warn(`Cleanup errors: ${deleteErrors.join('; ')}`);
    }

    try {
      const url = `https://api.github.com/repos/${node.owner}/${node.repo}/actions/variables/CONTROLLER_URL`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${node.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': USER_AGENT,
        }
      });
      if (!res.ok && res.status !== 404) {
        const errText = await res.text();
        console.warn(`Failed to delete CONTROLLER_URL: ${res.status} - ${errText}`);
      }
    } catch (e) {
      console.warn(`Failed to delete CONTROLLER_URL: ${e.message}`);
    }
  }

  const running = await env.NODE_KV.get('scheduler:running', 'json');
  if (running && running.node === id) {
    await env.NODE_KV.delete('scheduler:running');
  }

  await env.NODE_KV.delete(`node:${id}`);
  let list = await env.NODE_KV.get('nodes', 'json') || [];
  list = list.filter(item => item !== id);
  await env.NODE_KV.put('nodes', JSON.stringify(list));

  return json({ success: true });
}

// ---------- listNodes ----------
async function listNodes(env) {
  const ids = await env.NODE_KV.get('nodes', 'json') || [];
  const nodes = [];
  for (const id of ids) {
    const data = await env.NODE_KV.get(`node:${id}`, 'json');
    if (data) {
      const { token, ...safe } = data;
      nodes.push({ id, ...safe });
    }
  }
  return json({ nodes });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}