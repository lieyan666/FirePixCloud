const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const CryptoJS = require('crypto-js');

// 加载配置文件
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
const port = config.port || 3000;

// 存储活跃session
const activeSessions = new Map();

// 生成session ID
function generateSessionId(type) {
    const timestamp = new Date().getTime();
    const random = Math.random().toString();
    return CryptoJS.MD5(`${type}-${timestamp}-${random}`).toString();
}

// 清理过期session（30分钟）
setInterval(() => {
    const now = new Date().getTime();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.timestamp > 30 * 60 * 1000) {
            activeSessions.delete(sessionId);
        }
    }
}, 60000);

// 验证session中间件
function checkSession(type) {
    return (req, res, next) => {
        const sessionId = req.path.split('/')[2]; // 从/session/xxx获取sessionId
        const session = activeSessions.get(sessionId);
        
        if (!session || session.type !== type || 
            new Date().getTime() - session.timestamp > 30 * 60 * 1000) {
            return res.redirect('/login.html');
        }
        
        // 更新session时间戳
        session.timestamp = new Date().getTime();
        next();
    };
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// 静态文件服务
app.use(express.static('public'));
app.use(express.json());

// 登录处理
app.post('/login', express.json(), (req, res) => {
    const { type, password } = req.body;
    
    if (type === 'upload' && password === config.uploadPassword ||
        type === 'admin' && password === config.adminPassword) {
        
        const sessionId = generateSessionId(type);
        activeSessions.set(sessionId, {
            type,
            timestamp: new Date().getTime()
        });

        res.json({
            success: true,
            redirect: `/session/${sessionId}/${type === 'admin' ? 'admin.html' : 'index.html'}`
        });
    } else {
        res.json({ success: false });
    }
});

// 重定向首页到登录页
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// 处理session路由
app.use('/session/:sessionId', express.static('public'));

// 确保数据目录存在
const dataPath = path.join(__dirname, 'data', 'files.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify({}));
}

// 生成6位随机提取码
function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 读取文件数据
function readFileData() {
    const data = fs.readFileSync(dataPath);
    return JSON.parse(data);
}

// 保存文件数据
function saveFileData(data) {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// 处理文件上传
// 文件上传路由
app.post('/session/:sessionId/upload', checkSession('upload'), upload.array('files'), async (req, res) => {
    try {
        const files = req.files;
        const extractCode = generateCode();
        const verifyCode = uuidv4().substring(0, 6).toUpperCase();
        
        const fileData = readFileData();
        const uploadTime = new Date().toISOString();
        
        fileData[extractCode] = {
            verifyCode,
            files: files.map(file => ({
                originalName: file.originalname,
                filename: file.filename,
                path: file.path
            })),
            uploadTime,
            downloads: 0
        };
        
        saveFileData(fileData);
        
        // 生成二维码，包含提取码和校验码
        const qrData = JSON.stringify({
            extractCode,
            verifyCode
        });
        
        const qrCodeDataUrl = await QRCode.toDataURL(qrData);
        
        res.json({
            success: true,
            extractCode,
            verifyCode,
            qrCode: qrCodeDataUrl
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: 'Upload failed' });
    }
});

// 验证提取码和校验码
app.post('/verify', (req, res) => {
    const { extractCode, verifyCode } = req.body;
    const fileData = readFileData();
    
    if (fileData[extractCode] && fileData[extractCode].verifyCode === verifyCode) {
        res.json({
            success: true,
            files: fileData[extractCode].files
        });
    } else {
        res.status(400).json({
            success: false,
            error: 'Invalid codes'
        });
    }
});

// 获取统计数据
app.get('/session/:sessionId/api/stats', checkSession('admin'), (req, res) => {
    try {
        const fileData = readFileData();
        const stats = {
            totalFiles: Object.values(fileData).reduce((sum, item) => sum + item.files.length, 0),
            totalDownloads: Object.values(fileData).reduce((sum, item) => sum + item.downloads, 0),
            activeExtractCodes: Object.keys(fileData).length
        };
        res.json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// 获取文件列表
app.get('/session/:sessionId/api/files', checkSession('admin'), (req, res) => {
    try {
        const fileData = readFileData();
        const files = Object.entries(fileData).map(([extractCode, data]) => ({
            extractCode,
            verifyCode: data.verifyCode,
            files: data.files,
            uploadTime: data.uploadTime,
            downloads: data.downloads
        }));
        res.json(files);
    } catch (error) {
        console.error('Files list error:', error);
        res.status(500).json({ error: 'Failed to get files list' });
    }
});

// 删除文件
app.delete('/session/:sessionId/api/files/:extractCode', checkSession('admin'), (req, res) => {
    try {
        const { extractCode } = req.params;
        const fileData = readFileData();
        
        if (!fileData[extractCode]) {
            return res.status(404).json({ error: 'Files not found' });
        }

        // 删除文件
        fileData[extractCode].files.forEach(file => {
            const filePath = path.join(__dirname, file.path);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });

        // 从数据中删除记录
        delete fileData[extractCode];
        saveFileData(fileData);

        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete files' });
    }
});

// 处理文件下载
app.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    const { extractCode, verifyCode } = req.query;
    
    const fileData = readFileData();
    
    // 验证提取码和校验码
    if (!fileData[extractCode] || fileData[extractCode].verifyCode !== verifyCode) {
        return res.status(403).send('Access denied');
    }
    
    // 查找请求的文件
    const fileInfo = fileData[extractCode].files.find(f => f.filename === filename);
    if (!fileInfo) {
        return res.status(404).send('File not found');
    }
    
    // 更新下载次数
    fileData[extractCode].downloads += 1;
    saveFileData(fileData);
    
    // 发送文件
    res.download(fileInfo.path, fileInfo.originalName);
});

app.listen(port, () => {
    console.log(`FirePixCloud running at http://localhost:${port}`);
});
