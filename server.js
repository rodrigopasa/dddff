const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

// --- SUAS CREDENCIAIS ADMINISTRATIVAS (Edite aqui ou use Variáveis de Ambiente) ---
const MASTER_KEY = process.env.MASTER_KEY || 'admin123'; // Senha para criar usuários no painel
const EVO_URL = process.env.EVO_URL || 'https://sua-evolution-api.com'; // Sua URL Evolution
const EVO_APIKEY = process.env.EVO_APIKEY || 'sua-global-api-key-aqui'; // Sua Global API Key

app.use(express.json({ limit: '50mb' }));

// --- PERSISTÊNCIA ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ 
        users: { "admin": { pass: "admin", instanceName: "", logs: [] } } 
    }, null, 2));
}

// --- MEMÓRIA VOLÁTIL ---
const activeCampaigns = {}; 
const sessions = {}; 

// --- FUNÇÕES AUXILIARES ---
const getDB = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
const getUserData = (username) => getDB().users[username];

const saveUserLog = (username, type, text) => {
    try {
        const db = getDB();
        if (db.users[username]) {
            const time = new Date().toLocaleString();
            db.users[username].logs.unshift({ type, text, time });
            if(db.users[username].logs.length > 500) db.users[username].logs = db.users[username].logs.slice(0, 500);
            saveDB(db);
        }
    } catch(e) { console.error(e); }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    const token = req.headers['x-auth-token'];
    const user = sessions[token];
    if (!user) return res.status(401).json({ error: 'Não autorizado' });
    req.user = user;
    next();
};

// --- ROTAS DO SAAS (GERENCIAR INSTÂNCIA) ---

// 1. Criar Instância (Usa suas credenciais globais)
app.post('/api/evo/create', authMiddleware, async (req, res) => {
    const user = req.user;
    const { newInstanceName } = req.body;
    
    // Força o nome da instância ser único ou prefixado (opcional, aqui deixei livre)
    const finalName = newInstanceName.trim();

    try {
        const cleanUrl = EVO_URL.replace(/\/$/, '');
        console.log(`Criando instância ${finalName} em ${cleanUrl}...`);

        const response = await fetch(`${cleanUrl}/instance/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': EVO_APIKEY },
            body: JSON.stringify({ 
                instanceName: finalName, 
                qrcode: true, 
                integration: "WHATSAPP-BAILEYS" 
            })
        });
        
        const data = await response.json();
        
        if (response.ok || (data.instance && data.instance.status === 'created')) {
            // Salva a instância no cadastro do usuário
            const db = getDB();
            db.users[user].instanceName = finalName;
            saveDB(db);
            saveUserLog(user, 'success', `Instância ${finalName} vinculada com sucesso!`);
            res.json({ success: true, data });
        } else {
            // Se der erro (ex: já existe), mas o usuário for dono dela, podemos vincular?
            // Por segurança, retornamos o erro da API.
            res.status(400).json({ error: data.message || JSON.stringify(data) });
        }
    } catch (e) {
        res.status(500).json({ error: 'Erro no servidor Evolution: ' + e.message });
    }
});

// 2. Pegar QR Code (Usa suas credenciais globais)
app.get('/api/evo/qrcode', authMiddleware, async (req, res) => {
    const user = req.user;
    const userData = getUserData(user);
    const instanceName = userData.instanceName;

    if (!instanceName) return res.status(400).json({ error: 'Você ainda não criou uma instância.' });

    try {
        const cleanUrl = EVO_URL.replace(/\/$/, '');
        // Tenta conectar/buscar QR
        const response = await fetch(`${cleanUrl}/instance/connect/${instanceName}`, {
            headers: { 'apikey': EVO_APIKEY }
        });
        
        const data = await response.json();
        const qr = data.base64 || data.qrcode || (data.code ? data.code : null);
        
        if (qr) {
            res.json({ success: true, qrcode: qr });
        } else {
            // Se a instância já estiver conectada (state: open), avisa o front
            if(data.instance?.state === 'open' || data.state === 'open') {
                res.json({ success: true, connected: true });
            } else {
                res.json({ success: false, error: 'Instância existe mas não retornou QR (Verifique status)' });
            }
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Deletar Instância (Logout do Whatsapp)
app.post('/api/evo/delete', authMiddleware, async (req, res) => {
    const user = req.user;
    const userData = getUserData(user);
    const instanceName = userData.instanceName;

    if (!instanceName) return res.status(400).json({ error: 'Sem instância.' });

    try {
        const cleanUrl = EVO_URL.replace(/\/$/, '');
        await fetch(`${cleanUrl}/instance/delete/${instanceName}`, {
            method: 'DELETE',
            headers: { 'apikey': EVO_APIKEY }
        });
        
        const db = getDB();
        db.users[user].instanceName = ""; // Remove vínculo
        saveDB(db);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- ROTAS DE AUTH & USER ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = getDB();
    if (db.users[username] && db.users[username].pass === password) {
        const token = crypto.randomBytes(16).toString('hex');
        sessions[token] = username;
        res.json({ success: true, token, username });
    } else {
        res.status(401).json({ error: 'Credenciais inválidas' });
    }
});

app.post('/api/admin/create-user', (req, res) => {
    const { masterKey, newUser, newPass } = req.body;
    if (masterKey !== MASTER_KEY) return res.status(403).json({ error: 'Chave Mestra Inválida' });
    const db = getDB();
    if (db.users[newUser]) return res.status(400).json({ error: 'Usuário já existe' });
    db.users[newUser] = { pass: newPass, instanceName: "", logs: [] };
    saveDB(db);
    res.json({ success: true, message: `Usuário ${newUser} criado!` });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const userData = getUserData(req.user);
    res.json({ instanceName: userData.instanceName, logs: userData.logs });
});

// --- MOTOR DE ENVIO (Usa EVO_URL e EVO_APIKEY globais) ---
async function processQueue(username) {
    const campaign = activeCampaigns[username];
    if (!campaign || campaign.status !== 'running') return;
    
    // Pega a instância salva no banco de dados do usuário
    const db = getDB();
    const userInstance = db.users[username]?.instanceName;

    if(!userInstance) {
        saveUserLog(username, 'error', 'Fila parada: Usuário sem instância configurada.');
        campaign.status = 'idle';
        return;
    }

    console.log(`[${username}] Disparando pela instância: ${userInstance}`);

    while (campaign.currentIndex < campaign.targets.length) {
        if (campaign.stopSignal) {
            campaign.status = 'idle'; campaign.stopSignal = false;
            saveUserLog(username, 'warning', 'Campanha parada manualmente.');
            break;
        }
        const target = campaign.targets[campaign.currentIndex];
        const { type, message, mediaBase64, fileName, options } = campaign.messageData;

        const cleanUrl = EVO_URL.replace(/\/$/, '');
        let endpoint = type === 'text' ? `${cleanUrl}/message/sendText/${userInstance}` : `${cleanUrl}/message/sendMedia/${userInstance}`;
        
        let payload = type === 'text' 
            ? { number: target, options: { delay: 1200, linkPreview: options.linkPreview }, textMessage: { text: message } }
            : { number: target, options: { delay: 1200 }, mediaMessage: { mediatype: type, caption: message, media: mediaBase64, fileName } };

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': EVO_APIKEY },
                body: JSON.stringify(payload)
            });
            if (res.ok) { campaign.progress.success++; saveUserLog(username, 'success', `Enviado: ${target}`); } 
            else { 
                const errData = await res.json().catch(()=>({}));
                campaign.progress.fail++; 
                saveUserLog(username, 'error', `Falha ${target}: ${res.status} - ${JSON.stringify(errData)}`); 
            }
        } catch (err) { campaign.progress.fail++; saveUserLog(username, 'error', `Erro rede ${target}: ${err.message}`); }

        campaign.currentIndex++;
        if (campaign.currentIndex >= campaign.targets.length) { campaign.status = 'idle'; saveUserLog(username, 'success', 'Campanha finalizada!'); break; }
        const delayMs = Math.floor(Math.random() * (campaign.delays.max - campaign.delays.min + 1) + campaign.delays.min) * 1000;
        await wait(delayMs);
    }
}

app.post('/api/campaign/start', authMiddleware, (req, res) => {
    const user = req.user;
    if (activeCampaigns[user] && activeCampaigns[user].status === 'running') return res.status(400).json({ error: 'Já existe uma campanha rodando.' });
    
    // Valida se usuário tem instância
    const userData = getUserData(user);
    if (!userData.instanceName) return res.status(400).json({error: 'Você precisa criar uma instância primeiro.'});

    const { targets, messageData, delays } = req.body;
    activeCampaigns[user] = { status: 'running', targets, currentIndex: 0, progress: { success: 0, fail: 0, total: targets.length }, messageData, delays, stopSignal: false };
    saveUserLog(user, 'info', `Campanha iniciada (${targets.length} contatos)`);
    processQueue(user);
    res.json({ success: true });
});

app.post('/api/campaign/stop', authMiddleware, (req, res) => {
    const user = req.user;
    if (activeCampaigns[user]) activeCampaigns[user].stopSignal = true;
    res.json({ success: true });
});

app.get('/api/campaign/status', authMiddleware, (req, res) => {
    const user = req.user;
    const campaign = activeCampaigns[user];
    res.json(campaign ? { status: campaign.status, progress: campaign.progress } : { status: 'idle', progress: { current: 0, total: 0 } });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`PAZAP SaaS rodando na porta ${PORT}`));