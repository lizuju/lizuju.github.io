const USER = {
    name: '李祖钜 Gavin',
    avatar: 'https://github.com/lizuju.png'
};

const SUPPORTED_LANGS = ['zh-CN', 'en'];

const CONTENT = {
    'zh-CN': {
        brandName: '李祖钜 Gavin',
        navExperience: '工作',
        navProjects: '项目',
        navMethod: '方法',
        navSkills: '能力',
        navAwards: '荣誉',
        navContact: '联系',
        heroName: '李祖钜 Gavin',
        heroTitle: ['智能系统', '视觉算法', '机器人开发'],
        heroSummary: '把模型推理、视觉感知和硬件控制做成可运行的系统。',
        heroPrimary: '查看工作经历',
        heroSecondary: '联系我',
        heroTags: ['AI Agent', 'Computer Vision', 'Robotics', 'Full-stack'],
        briefAgentLabel: 'Agent 链路',
        briefAgentValue: '语音、检索、工具调用到硬件动作',
        briefVisionLabel: '视觉系统',
        briefVisionValue: '检测、标定、解算与实时优化',
        briefProductLabel: '产品交付',
        briefProductValue: '后端服务、前端界面与设备联调',
        signalRole: '当前方向',
        signalTitle: '语音 Agent 机器人',
        signalStack: 'FastAPI / ESP32 / RAG / CV',
        metricRank: '计算机专业综合排名',
        metricScholarship: '国家奖学金',
        metricAwards: '竞赛与创新项目荣誉',
        metricFocus: '语音机器人云端与设备协同',
        methodKicker: 'Method',
        methodTitle: '把复杂系统收束成可交付结果',
        methodBody: '先澄清，再提炼。先跑通闭环，再加固和打磨。',
        methodProofLabel: 'Working standard',
        methodProofValue: '清晰边界 / 可运行实现 / 可验证交付',
        experienceKicker: 'Experience',
        experienceTitle: '让模型决策落到真实设备',
        experienceCompany: '广东华南虎科技有限公司',
        experienceRole: 'AI Agent 语音陪伴机器人开发',
        experienceBody: '搭建云端服务与 ESP32 设备协同链路，让语音、检索、工具调用和硬件动作形成闭环。',
        experienceDetailLabel: '查看完整工作内容',
        mapAudio: '语音输入',
        mapReasoning: '模型推理',
        mapTools: '工具调用',
        mapDevice: '硬件执行',
        projectsKicker: 'Selected work',
        projectsTitle: '三条工程主线',
        projectDetailLabel: '展开技术细节',
        projectGitHub: '查看 GitHub',
        skillsKicker: 'Capability',
        skillsTitle: '从模型到产品的工程能力',
        awardsKicker: 'Proof',
        awardsTitle: '结果和长期投入',
        awardModelingTitle: '数学建模',
        awardRoboticsTitle: '机器人竞赛',
        awardInnovationTitle: '创新实践',
        awardOtherTitle: '综合荣誉',
        educationKicker: 'Education',
        educationTitle: '计算机科学与技术（本科）',
        educationBody: '综合排名 3/219；可使用英语、普通话和广东话工作沟通。',
        educationHighlights: ['两届国家奖学金', '励志榜样', '大学生年度人物', '学习先锋'],
        contactKicker: 'Contact',
        contactTitle: '如果你需要把智能能力落到真实设备和产品里，可以联系我。',
        footerName: '李祖钜 Gavin / Portfolio',
        footerTop: '回到顶部',
        methods: [
            {
                title: 'Clarify',
                label: '澄清目标',
                body: '把业务目标、硬件边界、验收标准和风险先拆清楚，避免后期返工。'
            },
            {
                title: 'Distill',
                label: '提炼路径',
                body: '删掉不必要的复杂度，保留能最快验证核心能力的工程路径。'
            },
            {
                title: 'Build',
                label: '实现闭环',
                body: '优先做可运行的端到端链路，再逐步补齐性能、体验和可维护性。'
            },
            {
                title: 'Harden',
                label: '加固边界',
                body: '关注重连、长文本、多语言、移动端和异常状态，让系统经得住真实使用。'
            },
            {
                title: 'Polish',
                label: '打磨细节',
                body: '用排版、间距、动效和浏览器回归把体验从“能用”推到“稳定好用”。'
            }
        ],
        experience: [
            '围绕“大模型决策 + 工具调用 + 多模态硬件执行”搭建云端服务与 ESP32 设备端协同链路，完成语音输入、LLM 推理、RAG 检索、工具调用、语音播报与硬件动作执行闭环。',
            '设计 WebSocket / MQTT 设备-云端实时通信协议，封装音频流、状态同步、控制指令与工具调用消息，支持多轮会话、设备状态机、流式音频传输与异常重连。',
            '在服务端集成 ASR、TTS、VAD、LLM API 与声纹识别模块，构建流式语音对话服务，支持边识别边生成、边生成边播报、多角色切换、音乐播放和提醒事项。',
            '负责 RAG 知识问答能力开发，设计知识库检索、上下文拼接、Prompt 模板与 LLM 调用流程，使机器人能够基于外部知识库完成问答、角色设定与场景化对话。',
            '设计并接入设备端 MCP / Tool Calling 工具体系，将拍照、屏幕控制、音量调节、舵机动作、状态查询等硬件能力封装为可被大模型调用的工具接口。',
            '负责声纹注册与识别链路开发，完成小程序、后端服务与语音服务三方联调，设计 PCM 音频上传、WebSocket 注册协议、声纹特征提取、用户身份绑定与 MySQL 落库流程。',
            '完成 ESP32 端多模态硬件能力适配，包括 GC2145 摄像头接入、JPEG 图像上传、屏幕与背光控制、STS 总线舵机控制，并将举手、挥手、复位、拥抱等动作编排接入 Agent 工具调用链路。'
        ],
        experienceStack: [
            'Python', 'C/C++', 'ESP32', 'LLM API', 'RAG', 'Prompt Engineering', 'Function Calling', 'MCP Tool',
            'WebSocket', 'MQTT', 'FastAPI', 'ASR/TTS/VAD', 'Opus', 'MySQL', 'Docker', 'Git'
        ],
        projects: [
            {
                title: 'RoboMaster 机器人视觉算法',
                role: '视觉组组长 / 项目负责人',
                period: '2022.11 - 2025.04',
                body: '面向比赛现场的实时视觉、目标识别和姿态解算。',
                alt: 'RoboMaster 机器人视觉系统产品式渲染图',
                details: [
                    '基于 ROS 与 OpenCV 构建完整视觉处理流程，包括去噪、滤波、图像增强、工业相机标定、畸变矫正和曝光/增益调节。',
                    '结合 YOLOv5 实现多类别目标检测与实时跟踪，提升复杂工业环境下的识别精度与系统鲁棒性。',
                    '负责视觉系统与电控系统联调，设计 IMU、编码器、激光雷达等多传感器数据采集与融合方案，实现运动姿态解算与路径规划。',
                    '在 MiniPC / 嵌入式平台完成算法移植与性能优化，通过 CUDA 加速、模型量化与推理优化提高实时性与资源利用效率。',
                    '使用 Git 进行代码管理与团队协作，推进模块化工程落地，并协调机械、电控等模块开发节奏。'
                ],
                result: '荣获 RoboMaster 机甲大师赛步兵对抗赛、3V3 对抗赛等多项奖项。',
                tags: ['C++', 'OpenCV', 'YOLOv5', 'ROS', 'CUDA', 'Linux', 'MiniPC', '工业相机', '姿态解算', 'Git'],
                visual: 'vision',
                link: 'https://github.com/notos-robomaster/NOTOS_RM_AutoAim'
            },
            {
                title: '机器视觉与雷达建模货物盘点系统',
                role: '全栈开发 / 项目负责人',
                period: '2023.09 - 2024.06',
                body: '用视觉与雷达融合，让货物识别、计数和异常检测自动化。',
                alt: '仓储货物盘点系统传感器场景图',
                details: [
                    '基于 ROS 与 OpenCV 构建图像预处理流程，包括去噪、透视矫正、区域裁剪等，并结合 YOLOv5 完成货物目标检测与类别识别。',
                    '结合雷达数据进行空间建模与距离测量，设计视觉与雷达数据融合逻辑，提升遮挡场景下的识别准确率和库存统计可靠性。',
                    '使用 Flask 构建后端服务，实现库存管理、数据存储与 RESTful API，基于 MySQL 完成数据库建模与索引优化。',
                    '基于 Vue 构建可视化管理界面，实现库存动态展示、统计分析与告警提示，完成前后端接口联调和系统部署。',
                    '对检测模型与系统性能进行优化，通过推理加速与数据结构改进提升仓储场景下的实时性和稳定性。'
                ],
                result: '荣获全国大学生创新创业能力大赛省级结项。',
                tags: ['Python', 'ROS', 'Flask', 'Vue', 'MySQL', 'OpenCV', 'YOLOv5', '多传感器融合', 'Zbar', 'Git'],
                visual: 'inventory'
            },
            {
                title: 'YOLOv5 垃圾分类识别系统',
                role: '全栈开发 / 项目负责人',
                period: '2024.02 - 2025.03',
                body: '把固定分类检测升级为“特征嵌入 + 向量搜索”的可扩展识别平台。',
                alt: '垃圾分类识别系统产品式静物图',
                details: [
                    '基于 YOLOv5 构建通用目标检测流程，负责物体定位与裁剪；引入 CLIP 进行特征嵌入提取，将垃圾图像转化为高维语义向量。',
                    '设计并搭建向量检索体系，结合 Milvus 构建“垃圾指纹库”，实现海量特征向量的相似度匹配与近邻搜索。',
                    '构建可动态扩展的识别机制，新增垃圾类型时无需重新训练检测模型，仅需新增样本向量入库即可完成扩展。',
                    '使用 Flask 封装检测与向量检索接口，基于 MySQL 管理用户与记录，采用 Vue 实现识别展示和历史管理功能。',
                    '优化向量检索效率与推理流程，通过索引结构优化和批量特征计算提升系统响应速度。'
                ],
                result: '荣获传智杯全国 IT 技能大赛一等奖。',
                tags: ['Python', 'Flask', 'Vue', 'MySQL', 'YOLOv5', 'CLIP', 'Milvus', 'Git'],
                visual: 'retrieval'
            }
        ],
        skills: [
            {
                title: '编程语言与全栈开发',
                body: 'C++ / Python 到 Flask、Vue、MySQL，能独立做前后端闭环。',
                items: ['C++ / STL', 'Python', 'Flask', 'Vue', 'RESTful API', 'MySQL']
            },
            {
                title: '数据结构与算法',
                body: '围绕性能瓶颈做复杂度、数据结构和并行计算优化。',
                items: ['数组', '链表', '二叉树', '快速排序', '复杂度优化']
            },
            {
                title: '计算机视觉',
                body: '从 OpenCV、YOLOv5 到相机标定和视觉工程部署。',
                items: ['OpenCV', 'YOLOv5', '工业相机', '相机标定', '图像增强']
            },
            {
                title: '机器人开发',
                body: 'ROS、传感器融合、姿态解算和 MiniPC 平台部署。',
                items: ['ROS', '传感器融合', '姿态解算', '串口通信', 'Jetson / NUC / Raspberry Pi']
            },
            {
                title: 'Linux 与工程工具链',
                body: 'Linux、多线程、GDB、Makefile 和 Git 工程工具链。',
                items: ['Linux', 'Shell', '多线程', 'GDB', 'Makefile', 'Git']
            },
            {
                title: 'AI Agent 与设备工具调用',
                body: 'RAG、工具调用、流式语音和硬件能力封装。',
                items: ['RAG', 'Prompt Engineering', 'MCP Tool', 'ASR/TTS/VAD', 'WebSocket', 'MQTT']
            },
            {
                title: '工程化协作与交付',
                body: '把澄清、实现、调试、文档和测试串成稳定交付流程。',
                items: ['Clarify', 'Distill', 'Harden', 'Polish', 'Codex', 'Claude Code']
            }
        ],
        modeling: [
            '2025 美国大学生数学建模竞赛全球 M 奖一等奖（Top 5%）',
            '2024 广东省大学生数学建模竞赛省级一等奖（Top 5%）',
            '2024 “华数杯”全国数学建模竞赛国家级二等奖',
            '2024 “中国电机工程学会杯”电工杯数学建模竞赛国家级三等奖',
            '2025 MathorCup 数学建模挑战赛省级一等奖'
        ],
        robotics: [
            'RoboMaster 2023 步兵对抗赛省级二等奖',
            'RoboMaster 2023 3V3 对抗赛省级三等奖',
            'RoboMaster 2024 步兵对抗赛省级三等奖',
            'RoboMaster 2024 3V3 对抗赛省级三等奖',
            'RoboMaster 2024 南部赛区省级三等奖'
        ],
        innovation: [
            '《基于大数据和物联网的城市洪涝灾害预警系统》国家级结项',
            '《以 ROS 为平台的 3D 激光雷达车辆路况感知系统》国家级结项',
            '《基于机器视觉和雷达建模的自动化货物盘点和管理系统》省级结项',
            '《基于深度卷积神经网络的手环特征精准识别系统》省级结项',
            '《全向移动射击机器人设立与实现》省级结项',
            '《多功能 SLAM-LiDAR 手持式激光雷达扫描仪与三维重建算法平台》省级结项'
        ],
        otherAwards: [
            '2025 第十六届蓝桥杯人工智能大学组全国选拔赛二等奖',
            '2024 传智杯全国 IT 技能大赛国家级一等奖',
            '2024 全国软件测试大赛国家级一等奖',
            '2025 华为 ICT 大赛实践赛省级三等奖',
            '2025 “挑战杯”广东大学生学术科技作品竞赛国家级二等奖',
            '2024 全国大学生电子商务赛省级二等奖',
            '2024 新文科实践创新大赛铜奖',
            '2025 “赢在广州”暨粤港澳大湾区大学生创业大赛创新奖',
            '实用型专利 1 项，软件著作权 4 项'
        ]
    },
    en: {
        brandName: 'Gavin Lizuju',
        navExperience: 'Experience',
        navProjects: 'Projects',
        navMethod: 'Method',
        navSkills: 'Skills',
        navAwards: 'Proof',
        navContact: 'Contact',
        heroName: 'Gavin Lizuju',
        heroTitle: ['Intelligent Systems', 'Vision Algorithms', 'Robotics Development'],
        heroSummary: 'Model reasoning, visual perception and device control in working systems.',
        heroPrimary: 'View experience',
        heroSecondary: 'Contact',
        heroTags: ['AI Agent', 'Computer Vision', 'Robotics', 'Full-stack'],
        briefAgentLabel: 'Agent loop',
        briefAgentValue: 'Voice, retrieval, tool calls and hardware actions',
        briefVisionLabel: 'Vision systems',
        briefVisionValue: 'Detection, calibration, pose solving and realtime tuning',
        briefProductLabel: 'Product delivery',
        briefProductValue: 'Backend services, frontend UI and device integration',
        signalRole: 'Current focus',
        signalTitle: 'Voice Agent Robotics',
        signalStack: 'FastAPI / ESP32 / RAG / CV',
        metricRank: 'CS program ranking',
        metricScholarship: 'National Scholarships',
        metricAwards: 'Awards and innovation results',
        metricFocus: 'Cloud-to-device voice robot systems',
        methodKicker: 'Method',
        methodTitle: 'Turning complex systems into shippable work',
        methodBody: 'Clarify first, distill the path, ship the loop, then harden and polish.',
        methodProofLabel: 'Working standard',
        methodProofValue: 'Clear scope / Working build / Verified delivery',
        experienceKicker: 'Experience',
        experienceTitle: 'Making model decisions reach real devices',
        experienceCompany: 'Guangdong South China Tiger Technology Co., Ltd.',
        experienceRole: 'AI Agent Voice Companion Robot Development',
        experienceBody: 'Built a cloud-to-ESP32 loop where voice, retrieval, tool calling and hardware actions work together.',
        experienceDetailLabel: 'View full scope',
        mapAudio: 'Voice input',
        mapReasoning: 'Model reasoning',
        mapTools: 'Tool calling',
        mapDevice: 'Device action',
        projectsKicker: 'Selected work',
        projectsTitle: 'Three engineering tracks',
        projectDetailLabel: 'Show technical details',
        projectGitHub: 'View GitHub',
        skillsKicker: 'Capability',
        skillsTitle: 'Engineering from model to product',
        awardsKicker: 'Proof',
        awardsTitle: 'Results and long-term commitment',
        awardModelingTitle: 'Mathematical Modeling',
        awardRoboticsTitle: 'Robotics',
        awardInnovationTitle: 'Innovation',
        awardOtherTitle: 'Other Honors',
        educationKicker: 'Education',
        educationTitle: 'Computer Science and Technology, Bachelor',
        educationBody: 'Ranked 3/219. Comfortable working in English, Mandarin and Cantonese.',
        educationHighlights: ['Two National Scholarships', 'Inspirational Role Model', 'Annual Student Figure', 'Learning Pioneer'],
        contactKicker: 'Contact',
        contactTitle: 'If you need intelligence deployed into real devices and products, let us talk.',
        footerName: 'Gavin Lizuju / Portfolio',
        footerTop: 'Back to top',
        methods: [
            {
                title: 'Clarify',
                label: 'Scope first',
                body: 'Define goals, device boundaries, acceptance criteria and risk before writing the system.'
            },
            {
                title: 'Distill',
                label: 'Keep the path sharp',
                body: 'Cut avoidable complexity and keep the fastest route that can validate the core capability.'
            },
            {
                title: 'Build',
                label: 'Close the loop',
                body: 'Ship a working end-to-end path first, then deepen performance, experience and maintainability.'
            },
            {
                title: 'Harden',
                label: 'Design for reality',
                body: 'Handle reconnects, long text, i18n, mobile layouts and exception states before delivery.'
            },
            {
                title: 'Polish',
                label: 'Refine the finish',
                body: 'Use typography, spacing, motion and browser regression to move the experience from usable to dependable.'
            }
        ],
        experience: [
            'Built a cloud-to-ESP32 collaboration loop around model decision-making, tool calling and multimodal hardware execution, covering voice input, LLM reasoning, RAG retrieval, tool calls, speech playback and hardware actions.',
            'Designed WebSocket / MQTT realtime protocols for device-cloud communication, wrapping audio streams, state sync, control commands and tool-calling messages with multi-turn sessions, device state switching, streaming audio and reconnect handling.',
            'Integrated ASR, TTS, VAD, LLM APIs and speaker recognition modules to build streaming voice dialogue, role switching, music playback and reminders.',
            'Developed RAG question answering, including knowledge retrieval, context assembly, prompt templates and LLM call flow for external-knowledge conversations and role settings.',
            'Designed device-side MCP / Tool Calling interfaces, exposing camera capture, screen control, volume adjustment, servo actions and status queries as model-callable tools.',
            'Developed speaker registration and recognition across mini program, backend services and voice services, covering PCM upload, WebSocket registration, feature extraction, user binding and MySQL persistence.',
            'Adapted ESP32 multimodal hardware capabilities, including GC2145 camera, JPEG upload, screen/backlight control and STS bus servos, wiring gestures such as raise hand, wave, reset and hug into the Agent tool loop.'
        ],
        experienceStack: [
            'Python', 'C/C++', 'ESP32', 'LLM API', 'RAG', 'Prompt Engineering', 'Function Calling', 'MCP Tool',
            'WebSocket', 'MQTT', 'FastAPI', 'ASR/TTS/VAD', 'Opus', 'MySQL', 'Docker', 'Git'
        ],
        projects: [
            {
                title: 'RoboMaster Robot Vision Algorithms',
                role: 'Vision Team Lead / Project Lead',
                period: '2022.11 - 2025.04',
                body: 'Realtime vision, target recognition and pose solving for competition robots.',
                alt: 'Premium product-style render of a RoboMaster robot vision system',
                details: [
                    'Built a complete ROS and OpenCV vision pipeline covering denoising, filtering, image enhancement, industrial camera calibration, distortion correction and exposure/gain tuning.',
                    'Combined YOLOv5 with multi-class detection and realtime tracking to improve recognition accuracy and robustness in complex environments.',
                    'Integrated the vision system with electrical control, designing multi-sensor acquisition and fusion across IMU, encoders and LiDAR for pose solving and path planning.',
                    'Ported and optimized algorithms on MiniPC / embedded platforms with CUDA acceleration, quantization and inference tuning for realtime performance.',
                    'Used Git for team collaboration, promoted modular engineering, and coordinated mechanical and electrical module schedules.'
                ],
                result: 'Won multiple RoboMaster awards across infantry combat and 3V3 competitions.',
                tags: ['C++', 'OpenCV', 'YOLOv5', 'ROS', 'CUDA', 'Linux', 'MiniPC', 'Industrial Camera', 'Pose Estimation', 'Git'],
                visual: 'vision',
                link: 'https://github.com/notos-robomaster/NOTOS_RM_AutoAim'
            },
            {
                title: 'Machine Vision and Radar Inventory System',
                role: 'Full-stack Developer / Project Lead',
                period: '2023.09 - 2024.06',
                body: 'Vision-radar fusion for automated recognition, counting and anomaly detection.',
                alt: 'Warehouse inventory sensor scene with modular boxes',
                details: [
                    'Built image preprocessing with ROS and OpenCV, including denoising, perspective correction and region cropping, then used YOLOv5 for item detection and category recognition.',
                    'Combined radar data for spatial modeling and distance measurement, designing vision-radar fusion to improve counting reliability under occlusion.',
                    'Built Flask backend services for inventory management, storage and RESTful APIs, with MySQL modeling and index optimization.',
                    'Implemented a Vue management interface for dynamic inventory display, analytics and alerts, then completed API integration and deployment.',
                    'Optimized detection model and system performance through inference acceleration and data-structure improvements.'
                ],
                result: 'Completed as a provincial-level innovation and entrepreneurship training project.',
                tags: ['Python', 'ROS', 'Flask', 'Vue', 'MySQL', 'OpenCV', 'YOLOv5', 'Sensor Fusion', 'Zbar', 'Git'],
                visual: 'inventory'
            },
            {
                title: 'YOLOv5 Garbage Classification System',
                role: 'Full-stack Developer / Project Lead',
                period: '2024.02 - 2025.03',
                body: 'An extensible recognition platform using feature embeddings and vector search.',
                alt: 'Product-style still life for garbage classification recognition',
                details: [
                    'Used YOLOv5 for generic object localization and cropping, then introduced CLIP feature embeddings to encode garbage images as high-dimensional semantic vectors.',
                    'Designed a vector retrieval system with Milvus as a garbage fingerprint library for efficient similarity search and nearest-neighbor matching.',
                    'Built a dynamic extension mechanism where new garbage categories can be added by inserting sample vectors without retraining the detector.',
                    'Wrapped detection and vector search APIs with Flask, used MySQL for users and records, and implemented recognition display plus history management in Vue.',
                    'Optimized vector retrieval and inference through index tuning and batched feature computation.'
                ],
                result: 'Won first prize in the national Chuanzhi Cup IT Skills Competition.',
                tags: ['Python', 'Flask', 'Vue', 'MySQL', 'YOLOv5', 'CLIP', 'Milvus', 'Git'],
                visual: 'retrieval'
            }
        ],
        skills: [
            {
                title: 'Programming and Full-stack',
                body: 'C++ / Python plus Flask, Vue and MySQL for end-to-end product loops.',
                items: ['C++ / STL', 'Python', 'Flask', 'Vue', 'RESTful API', 'MySQL']
            },
            {
                title: 'Data Structures and Algorithms',
                body: 'Complexity, data layout and parallel-computation tuning around bottlenecks.',
                items: ['Arrays', 'Linked Lists', 'Binary Trees', 'Quick Sort', 'Complexity Tuning']
            },
            {
                title: 'Computer Vision',
                body: 'OpenCV, YOLOv5, calibration and deployment-minded vision engineering.',
                items: ['OpenCV', 'YOLOv5', 'Industrial Cameras', 'Calibration', 'Image Enhancement']
            },
            {
                title: 'Robotics Development',
                body: 'ROS, sensor fusion, pose solving and MiniPC deployment.',
                items: ['ROS', 'Sensor Fusion', 'Pose Solving', 'Serial Control', 'Jetson / NUC / Raspberry Pi']
            },
            {
                title: 'Linux and Toolchain',
                body: 'Linux, multithreading, GDB, Makefile and Git toolchains.',
                items: ['Linux', 'Shell', 'Multithreading', 'GDB', 'Makefile', 'Git']
            },
            {
                title: 'AI Agent and Device Tooling',
                body: 'RAG, tool calling, streaming voice and hardware capability wrappers.',
                items: ['RAG', 'Prompt Engineering', 'MCP Tool', 'ASR/TTS/VAD', 'WebSocket', 'MQTT']
            },
            {
                title: 'Engineering Collaboration and Delivery',
                body: 'A workflow for scoping, implementation, debugging, docs and verified delivery.',
                items: ['Clarify', 'Distill', 'Harden', 'Polish', 'Codex', 'Claude Code']
            }
        ],
        modeling: [
            '2025 MCM Meritorious Winner, Top 5%',
            '2024 Guangdong Mathematical Modeling Provincial First Prize, Top 5%',
            '2024 Huashu Cup National Mathematical Modeling Second Prize',
            '2024 CSEE Cup Electrical Engineering Mathematical Modeling National Third Prize',
            '2025 MathorCup Provincial First Prize'
        ],
        robotics: [
            'RoboMaster 2023 Infantry Combat Provincial Second Prize',
            'RoboMaster 2023 3V3 Combat Provincial Third Prize',
            'RoboMaster 2024 Infantry Combat Provincial Third Prize',
            'RoboMaster 2024 3V3 Combat Provincial Third Prize',
            'RoboMaster 2024 Southern Region Provincial Third Prize'
        ],
        innovation: [
            'Urban flood disaster warning system based on big data and IoT, national-level completion',
            '3D LiDAR vehicle road perception system based on ROS, national-level completion',
            'Automated inventory and management system based on machine vision and radar modeling, provincial-level completion',
            'Bracelet feature recognition system based on deep convolutional neural networks, provincial-level completion',
            'Omnidirectional mobile shooting robot design and implementation, provincial-level completion',
            'Multifunctional SLAM-LiDAR handheld scanner and 3D reconstruction algorithm platform, provincial-level completion'
        ],
        otherAwards: [
            '2025 Lanqiao Cup AI undergraduate group national qualifier second prize',
            '2024 Chuanzhi Cup National IT Skills Competition First Prize',
            '2024 National Software Testing Competition First Prize',
            '2025 Huawei ICT Competition Practice Track Provincial Third Prize',
            '2025 Challenge Cup Guangdong Academic Science and Technology Works Competition National Second Prize',
            '2024 National College E-commerce Competition Provincial Second Prize',
            '2024 New Liberal Arts Practice Innovation Competition Bronze Award',
            '2025 Win in Guangzhou and Greater Bay Area College Entrepreneurship Competition Innovation Award',
            '1 utility patent and 4 software copyrights'
        ]
    }
};

let revealObserver;

function normalizeLanguage(lang) {
    return SUPPORTED_LANGS.includes(lang) ? lang : 'zh-CN';
}

function readStoredLanguage() {
    try {
        return localStorage.getItem('portfolio-lang');
    } catch {
        return null;
    }
}

function storeLanguage(lang) {
    try {
        localStorage.setItem('portfolio-lang', lang);
    } catch {
        // Language persistence is optional; the page should still work without browser storage.
    }
}

const legacyRouteMap = {
    education: 'education',
    experience: 'experience',
    'technical-skills': 'skills',
    projects: 'projects',
    awards: 'awards'
};

let currentLang = normalizeLanguage(readStoredLanguage());

function t() {
    return CONTENT[currentLang] || CONTENT['zh-CN'];
}

function renderList(name, items) {
    document.querySelectorAll(`[data-list="${name}"]`).forEach((container) => {
        const tagList = name === 'heroTags' || name === 'experienceStack' || name === 'educationHighlights';
        container.replaceChildren();
        items.forEach((item) => {
            const element = document.createElement(tagList ? 'span' : 'li');
            element.textContent = item;
            container.append(element);
        });
    });
}

function renderProjects(projects) {
    const container = document.querySelector('[data-projects]');
    if (!container) return;

    const visualTypes = ['vision', 'inventory', 'retrieval'];
    const visualAssets = {
        vision: 'assets/project-vision.jpg',
        inventory: 'assets/project-inventory.jpg',
        retrieval: 'assets/project-retrieval.jpg'
    };
    const copy = t();

    container.replaceChildren();
    projects.forEach((project, index) => {
        const visual = visualTypes.includes(project.visual) ? project.visual : 'vision';
        const card = document.createElement('article');
        card.className = `project-card project-card--${visual} reveal`;

        const meta = document.createElement('div');
        meta.className = 'project-index';
        meta.textContent = `${String(index + 1).padStart(2, '0')} / ${project.period}`;

        const media = document.createElement('figure');
        media.className = 'project-media';
        const image = document.createElement('img');
        image.src = visualAssets[visual];
        image.alt = project.alt || project.title;
        image.loading = index === 0 ? 'eager' : 'lazy';
        image.width = 1672;
        image.height = 941;
        media.append(image);

        const body = document.createElement('div');
        body.className = 'project-body';
        const title = document.createElement('h3');
        title.textContent = project.title;
        const role = document.createElement('strong');
        role.className = 'project-role';
        role.textContent = project.role;
        const description = document.createElement('p');
        description.textContent = project.body;
        const tags = document.createElement('div');
        tags.className = 'tags';
        project.tags.slice(0, 5).forEach((tag) => {
            const tagElement = document.createElement('span');
            tagElement.textContent = tag;
            tags.append(tagElement);
        });

        const detailsDrawer = document.createElement('details');
        detailsDrawer.className = 'project-details';
        const summary = document.createElement('summary');
        summary.textContent = copy.projectDetailLabel;
        const details = document.createElement('ul');
        details.className = 'detail-list';
        project.details.forEach((detail) => {
            const item = document.createElement('li');
            item.textContent = detail;
            details.append(item);
        });
        detailsDrawer.append(summary, details);

        const result = document.createElement('p');
        result.className = 'result-line';
        result.textContent = project.result;
        body.append(meta, title, role, description, tags, detailsDrawer, result);

        if (project.link) {
            const link = document.createElement('a');
            link.className = 'project-link';
            link.href = project.link;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.textContent = copy.projectGitHub;
            body.append(link);
        }

        card.append(media, body);
        container.append(card);
    });
}

function renderMethods(methods) {
    const container = document.querySelector('[data-methods]');
    if (!container) return;

    container.replaceChildren();
    methods.forEach((method, index) => {
        const step = document.createElement('article');
        step.className = 'method-step';

        const number = document.createElement('span');
        number.textContent = String(index + 1).padStart(2, '0');
        const title = document.createElement('h3');
        title.textContent = method.title;
        const label = document.createElement('strong');
        label.textContent = method.label;
        const body = document.createElement('p');
        body.textContent = method.body;

        step.append(number, title, label, body);
        container.append(step);
    });
}

function renderSkills(skills) {
    const container = document.querySelector('[data-skills]');
    if (!container) return;

    container.replaceChildren();
    skills.forEach((skill, index) => {
        const card = document.createElement('article');
        card.className = 'skill-card reveal';
        const number = document.createElement('span');
        number.setAttribute('aria-hidden', 'true');
        number.textContent = String(index + 1).padStart(2, '0');
        const title = document.createElement('h3');
        title.textContent = skill.title;
        const body = document.createElement('p');
        body.textContent = skill.body;
        const items = document.createElement('div');
        items.className = 'skill-items';
        skill.items.forEach((item) => {
            const tag = document.createElement('span');
            tag.textContent = item;
            items.append(tag);
        });
        card.append(number, title, body, items);
        container.append(card);
    });
}

function applyLanguage() {
    const copy = t();

    document.documentElement.lang = currentLang === 'zh-CN' ? 'zh-CN' : 'en';
    document.title = currentLang === 'zh-CN'
        ? '李祖钜 Gavin - 个人作品集'
        : 'Gavin Lizuju - Portfolio';

    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.getAttribute('data-i18n');
        if (copy[key]) element.textContent = copy[key];
    });

    document.querySelectorAll('[data-i18n-lines]').forEach((element) => {
        const key = element.getAttribute('data-i18n-lines');
        if (!Array.isArray(copy[key])) return;
        element.replaceChildren();
        copy[key].forEach((line) => {
            const span = document.createElement('span');
            span.textContent = line;
            element.append(span);
        });
    });

    renderList('experience', copy.experience);
    renderList('experienceStack', copy.experienceStack);
    renderList('heroTags', copy.heroTags);
    renderList('modeling', copy.modeling);
    renderList('robotics', copy.robotics);
    renderList('innovation', copy.innovation);
    renderList('otherAwards', copy.otherAwards);
    renderList('educationHighlights', copy.educationHighlights);
    renderMethods(copy.methods);
    renderProjects(copy.projects);
    renderSkills(copy.skills);

    const langButton = document.querySelector('[data-lang-toggle]');
    if (langButton) langButton.textContent = currentLang === 'zh-CN' ? 'EN' : '中文';

    setupRevealObserver();
}

function setupRevealObserver() {
    const items = document.querySelectorAll('.reveal');

    if (!('IntersectionObserver' in window)) {
        items.forEach((item) => item.classList.add('visible'));
        return;
    }

    revealObserver?.disconnect();
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.16 });
    revealObserver = observer;

    items.forEach((item) => {
        item.classList.remove('visible');
        revealObserver.observe(item);
    });
}

function closeMobileMenu() {
    document.body.classList.remove('menu-open');
    document.querySelector('[data-mobile-menu]')?.classList.remove('active');
    const button = document.querySelector('[data-menu-toggle]');
    if (button) {
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Open menu');
    }
}

function setupInteractions() {
    document.querySelector('[data-lang-toggle]')?.addEventListener('click', () => {
        currentLang = normalizeLanguage(currentLang) === 'zh-CN' ? 'en' : 'zh-CN';
        storeLanguage(currentLang);
        applyLanguage();
    });

    document.querySelector('[data-menu-toggle]')?.addEventListener('click', (event) => {
        const open = document.body.classList.toggle('menu-open');
        document.querySelector('[data-mobile-menu]')?.classList.toggle('active', open);
        event.currentTarget.setAttribute('aria-expanded', String(open));
        event.currentTarget.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });

    document.querySelectorAll('a[href^="#"]').forEach((link) => {
        link.addEventListener('click', closeMobileMenu);
    });
}

function routeLegacySkillLinks() {
    const skill = new URLSearchParams(window.location.search).get('skill');
    const section = legacyRouteMap[skill];
    if (!section) return;

    window.requestAnimationFrame(() => {
        document.getElementById(section)?.scrollIntoView();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('img[src="' + USER.avatar + '"]').forEach((img) => {
        img.alt = USER.name;
    });

    const favicon = document.getElementById('favicon');
    if (favicon) favicon.href = USER.avatar;

    setupInteractions();
    applyLanguage();
    routeLegacySkillLinks();
});
