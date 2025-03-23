/*
 * @Author: Lieyan
 * @Date: 2025-03-23 13:17:46
 * @LastEditors: Lieyan
 * @LastEditTime: 2025-03-23 13:17:56
 * @FilePath: /FirePixCloud/fix-encoding.js
 * @Description: 
 * @Contact: QQ: 2102177341  Website: lieyan.space  Github: @lieyan666
 * @Copyright: Copyright (c) 2025 by lieyanDevTeam, All Rights Reserved. 
 */
const fs = require('fs');
const path = require('path');

// 读取文件数据
const dataPath = path.join(__dirname, 'data', 'files.json');
const fileData = JSON.parse(fs.readFileSync(dataPath));

// 修复编码
Object.values(fileData).forEach(entry => {
    entry.files.forEach(file => {
        try {
            // 尝试修复乱码的文件名
            const decodedName = Buffer.from(file.originalName, 'binary').toString('utf8');
            file.originalName = decodedName;
        } catch (error) {
            console.error('Failed to fix encoding for:', file.originalName);
        }
    });
});

// 保存修复后的数据
fs.writeFileSync(dataPath, JSON.stringify(fileData, null, 2));
console.log('Encoding fix completed');
