const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = 3000;

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
app.post('/upload', upload.array('files'), async (req, res) => {
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
