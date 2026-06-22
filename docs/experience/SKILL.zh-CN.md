# 工作经历

---

## 广东华南虎科技有限公司
**2025.06 - 2026.05** | AI Agent 语音陪伴机器人开发

**技术栈：** Python，C/C++，ESP32，LLM API，AI Agent，Agent Workflow，RAG，Function Calling / MCP Tool，WebSocket，MQTT，FastAPI，ASR/TTS/VAD，Opus，Git

### 工作内容
- 负责智能语音机器人 AI Agent 系统开发，构建“LLM 决策 + RAG 检索 + Tool Calling + ESP32 硬件执行”的云边协同架构，实现语音输入、模型推理、工具调用、语音播报与设备动作闭环。
- 设计 WebSocket / MQTT 实时通信链路，封装音频流、设备状态、控制指令与工具调用消息，支持多轮会话管理、流式音频传输、设备状态机切换和异常重连。
- 在服务端集成 ASR、VAD、TTS、LLM、大模型 API 与声纹识别模块，搭建低延迟流式语音对话流程，支持边识别边生成、边生成边播报和多角色对话。
- 负责 RAG 知识问答与 Agent 工具体系开发，设计知识库检索、上下文拼接、Prompt 模板和工具路由流程，将音乐播放、提醒事项、拍照、音量调节、屏幕控制等能力封装为可调用工具。
- 完成 ESP32 端多模态硬件适配，接入 GC2145 摄像头、JPEG 图像上传、屏幕背光控制和 STS 总线舵机动作编排，实现举手、挥手、复位、拥抱等动作由 Agent 自动规划与执行。
