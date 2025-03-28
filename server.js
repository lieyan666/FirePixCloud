const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const CryptoJS = require('crypto-js');
const sharp = require('sharp');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// 配置日志
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new DailyRotateFile({
      filename: 'logs/application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    })
  ]
});

// 确保日志目录存在
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// 图片文件扩展名
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

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

// 请求日志中间件
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      message: 'HTTP request',
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
}

// 验证session中间件
function checkSession(type) {
    return (req, res, next) => {
        const sessionId = req.path.split('/')[2]; // 从/session/xxx获取sessionId
        const session = activeSessions.get(sessionId);
        
        if (!session || session.type !== type || 
            new Date().getTime() - session.timestamp > 30 * 60 * 1000) {
            logger.warn(`Invalid session attempt: ${sessionId}`);
            return res.redirect('/login');
        }
        
        // 更新session时间戳
        session.timestamp = new Date().getTime();
        next();
    };
}

// 确保上传目录存在
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
if (!fs.existsSync('uploads/thumbnails')) {
    fs.mkdirSync('uploads/thumbnails');
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        // 使用 Buffer 转换确保正确的编码
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        // 保存编码后的文件名，使用一次性的 UTF-8 编码
        const timestamp = Date.now();
        const encodedFilename = encodeURIComponent(originalName);
        // 确保解码正确
        const decodedFilename = decodeURIComponent(encodedFilename);
        // 再次编码，确保只有一层编码
        const finalFilename = encodeURIComponent(decodedFilename);
        cb(null, timestamp + '-' + finalFilename);
    }
});

const upload = multer({ storage: storage });

// 静态文件服务
app.use('/public', express.static('public'));
app.use('/thumbnails', express.static(path.join(__dirname, 'uploads', 'thumbnails'))); // 添加缩略图访问路由
app.use(express.json());
app.use(requestLogger);

// 特定页面路由
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/download', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

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
            redirect: `/session/${sessionId}/${type === 'admin' ? 'admin' : 'upload'}`
        });
    } else {
        res.json({ success: false });
    }
});

// 重定向首页到登录页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 处理session路由
app.get('/session/:sessionId/upload', checkSession('upload'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

app.get('/session/:sessionId/admin', checkSession('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 确保数据目录存在
const dataPath = path.join(__dirname, 'data', 'files.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify({}));
}

// 生成4位随机数字提取码
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
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
        const verifyCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        const fileData = readFileData();
        const uploadTime = new Date().toISOString();
        
        fileData[extractCode] = {
            verifyCode,
            files: files.map(file => {
                // 原始文件名已经在multer中被正确转换为UTF-8
                const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
                return {
                    originalName,
                    filename: file.filename,
                    path: file.path,
                    isImage: imageExtensions.includes(path.extname(originalName).toLowerCase()),
                    thumbnailPath: null
                };
            }),
            uploadTime,
            downloads: 0
        };
        
        // 为图片生成缩略图
        for (const fileEntry of fileData[extractCode].files) {
            if (fileEntry.isImage) {
                const thumbnailFilename = `thumb_${fileEntry.filename}`;
                const thumbnailPath = path.join('uploads', 'thumbnails', thumbnailFilename);
                const fullThumbnailPath = path.join(__dirname, thumbnailPath);
                
                await sharp(path.join(__dirname, fileEntry.path))
                    .resize(200, 200, {
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .toFile(fullThumbnailPath);
                
                fileEntry.thumbnailPath = thumbnailPath;
            }
        }

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
        logger.error('Upload error', { error: error.message, stack: error.stack });
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
        logger.error('Stats error', { error: error.message, stack: error.stack });
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
        logger.error('Files list error', { error: error.message, stack: error.stack });
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

            if (file.thumbnailPath) {
                const thumbnailPath = path.join(__dirname, 'uploads', 'thumbnails', `thumb_${file.filename}`);
                if (fs.existsSync(thumbnailPath)) {
                    fs.unlinkSync(thumbnailPath);
                }
            }
        });

        // 从数据中删除记录
        delete fileData[extractCode];
        saveFileData(fileData);

        res.json({ success: true });
    } catch (error) {
        logger.error('Delete error', { error: error.message, stack: error.stack });
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
    
    // 设置必要的响应头以确保正确的字符编码
    res.setHeader('Content-Type', 'application/octet-stream; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.originalName)}`);
    
    // 发送文件
    fs.createReadStream(fileInfo.path).pipe(res);
});

app.listen(port, () => {
    logger.info(`FirePixCloud running at http://localhost:${port}`);
});
