# DLPromo · 番茄专注时钟（ТОМАТО-ЧАСЫ）

一个轻量、自带后端的番茄工作法（Pomodoro）专注时钟，全部前端逻辑与样式内嵌于单个 HTML，后端为 Flask + SQLite。

## 特性

- ⏱ **专注 / 短休 / 长休** 三种模式，25+5=30 经典节奏，可自定义时长
- 🔢 **8 位晶体管风格数码管**（DSEG7 七段字体，内嵌 woff2），高对比度 + 发光效果，可读性强
- 📱 **移动端响应式**：触控友好按钮（≥44px）、防 iOS 缩放输入框、小屏自适应布局
- 📊 **统计面板**：专注总数 / 总时长 / 最长连击 / 今日统计
- 🔥 **热力图**：近 12 周每日专注时长可视化
- 📋 **记录管理**：完成 / 跳过 / 放弃 全流程入档，支持编辑与删除
- 📤 **导出**：CSV / JSON
- ⚙️ 结算规则：放弃计入原因与时长但不计入总专注时长；跳过按原计划时长入账

## 快速开始

```bash
# 1. 创建并激活虚拟环境
python3 -m venv venv
source venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt

# 3. 运行
python main.py
```

打开浏览器访问 http://127.0.0.1:8000

## 项目结构

- `main.py` - Flask + SQLite 后端（CRUD API、统计聚合、热力图数据、CSV/JSON 导出）
- `index.html` - 前端单页（样式 / 脚本 / DSEG7 字体全部内嵌）
- `requirements.txt` - Python 依赖
- `test_api.py` - API 测试脚本

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/records` | 记录列表 / 新增记录 |
| PUT/DELETE | `/api/records/<id>` | 更新 / 删除记录 |
| GET | `/api/stats?days=N` | 统计聚合 |
| GET | `/api/heatmap` | 热力图日数据 |
| GET | `/api/export?format=csv\|json` | 导出 |

## 技术栈

Flask · SQLite · 原生 JavaScript（无前端依赖）· DSEG7 字体（SIL OFL 许可）