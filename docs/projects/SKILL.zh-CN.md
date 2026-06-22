# 项目经历

---

## AI Agent 简历生成与优化平台
**2025.10 - 2026.05** | 全栈开发 & 项目负责人

**技术栈：** Python，Flask，React，PostgreSQL，SQLAlchemy，LLM，AI Agent，RAG，Embedding，向量检索，Structured Output，LaTeX，Git

### 工作内容
- 独立设计并实现面向求职场景的 AI Agent 简历生成与优化平台，将简历解析、岗位 JD 分析、内容改写、LaTeX 渲染与 PDF 导出串联为自动化简历生成链路。
- 设计 Agentic Resume Workflow，引入 Intent Routing 与 Task Orchestration，将用户输入路由到整份生成、JD 匹配、局部改写、压缩优化等任务分支。
- 采用 Schema-first 的 JSON Resume 中间表示，将简历字段与 LaTeX 模板解耦，形成 Structured Output + Renderer Pipeline，支持字段级编辑、版本回溯和 PDF 导出。
- 引入 RAG、Embedding 与向量数据库设计用户简历记忆模块，对项目经历、技能关键词、历史优化版本和目标岗位信息进行检索增强，支持多轮对话中的个性化续写与局部修改。
- 基于 Flask 封装文件解析、AI 改写、LaTeX 编译、PDF 导出、公开分享和订阅校验等 Agent 工具接口，并使用 React + Vite 构建对话式简历编辑与 PDF 预览界面。

**项目成果：** 上线后累计服务上百名求职用户

---

## RoboMaster 机器人计算机视觉算法开发
**2022.11 - 2025.04** | 视觉组组长 & 项目负责人

**技术栈：** C++，OpenCV，ROS，PnP 位姿估计，Kalman Filter，相机标定，工业相机，MiniPC，Git

### 工作内容
- 作为视觉组组长及项目负责人，负责 RoboMaster 机器人自瞄系统开发，完成装甲板检测、目标选择、角度解算、预测滤波与 MiniPC-STM32 联调。
- 基于 ROS 系统与 OpenCV 构建传统视觉装甲板识别链路，通过颜色通道差分、形态学膨胀、轮廓提取、椭圆拟合、灯条筛选与装甲板匹配实现目标检测。
- 设计装甲板评分与目标选择策略，结合装甲板面积、目标编号优先级、上一帧目标位置距离等因素进行候选目标排序与跟踪。
- 实现 AngleSolver 角度解算模块，基于相机内参、畸变参数、solvePnP / PinHole 模型计算 yaw、pitch 与距离，并加入枪口-相机偏移和弹道重力补偿。
- 引入 Kalman Filter 对装甲板中心点进行状态预测与测量校正，降低目标跳变、短时丢失和画面抖动对云台控制的影响。
- 负责 Linux 串口通信与电控联调，基于 termios 配置 MiniPC 串口参数，设计 yaw / pitch 数据帧、符号位、小数位与发弹标志位，实现视觉结果到 STM32 云台控制的实时传输。

**项目成果：** 荣获两届 RoboMaster 机甲大师赛步兵对抗赛 & 3V3 对抗赛多项奖项

**GitHub：** [notos-rm-autoaim](https://github.com/lizuju/notos-rm-autoaim)

---

## TAAC 2026 腾讯广告算法大赛
**2026.04 - 2026.05** | 算法开发

**技术栈：** Python，PyTorch，Transformer，推荐系统，CTR/CVR 预估，AUC 优化，Parquet，特征工程，Focal Loss，Git

### 工作内容
- 基于 PyTorch 构建面向广告推荐场景的转化率预测模型，围绕用户特征、物品特征、行为序列和时间特征进行建模，冲击 AUC 最优成绩为目标持续迭代方案。
- 负责 Parquet 训练数据读取、schema 对齐、padding、序列截断与特征处理，整理 user sparse、item sparse、user dense 及多路行为序列的模型输入。
- 在模型结构上引入 RankMixer NS Tokenizer、MultiSeqQueryGenerator、MultiSeqHyFormerBlock 等模块，对用户侧稀疏特征、物品侧稀疏特征和行为序列进行交互建模。
- 针对 user dense 特征语义混杂问题，设计 dense group projector 分组投影与 gate 融合机制，将 dense 61、87、62-66、89-91 等特征分组建模后融合为 user dense token。
- 通过加入全局时间特征、调优 Focal Loss 参数、优化 step-level validation 与 checkpoint 选择策略，将 Public AUC 从初始 baseline 的 0.806617 提升至 0.830964，并整理 35 轮实验记录。

**项目成果：** 荣获腾讯广告算法大赛 114 名（Top 7%）

**GitHub：** [TAAC-2026](https://github.com/lizuju/TAAC-2026)

---

## YOLOv5 垃圾分类识别系统
**2024.02 - 2025.03** | 全栈开发 & 项目负责人

**技术栈：** Python，Flask，Vue，MySQL，YOLOv5，CLIP，Milvus，Git

### 工作内容
- 负责 YOLOv5 智能垃圾识别系统架构设计，将传统固定类别检测改造为“目标检测 + 语义向量检索”流程，实现检测模型与垃圾类别库解耦。
- 基于 YOLOv5 完成垃圾目标定位与裁剪，结合 CLIP 提取图像 Embedding，将垃圾图像编码为高维语义向量，用于后续相似度匹配。
- 设计 Milvus 向量检索模块，构建垃圾样本指纹库，基于 TopK 近邻搜索与相似度排序完成类别判定，支持新增垃圾类别样本向量入库。
- 使用 Flask 封装检测、Embedding 提取与向量检索接口，结合 MySQL 管理用户与识别记录，基于 Vue 实现图片识别、批量检测和历史记录管理。

**项目成果：** 荣获传智杯全国 IT 技能大赛一等奖
