# Projects

---

## AI Agent Resume Generation and Optimization Platform
**2025.10 - 2026.05** | Full-stack Developer & Project Lead

**Tech Stack:** Python, Flask, React, PostgreSQL, SQLAlchemy, LLM, AI Agent, RAG, Embedding, Vector Search, Structured Output, LaTeX, Git

### Work Scope
- Designed and implemented an AI Agent resume generation and optimization platform for job-search scenarios, connecting resume parsing, JD analysis, content rewriting, LaTeX rendering and PDF export.
- Designed an Agentic Resume Workflow with Intent Routing and Task Orchestration, routing user input into full resume generation, JD matching, local rewriting and compression tasks.
- Used a schema-first JSON Resume intermediate representation to decouple resume fields from LaTeX templates, forming a Structured Output and Renderer Pipeline with field-level editing, version rollback and PDF export.
- Introduced RAG, embeddings and vector database design for user resume memory, retrieving projects, skills, historical optimization versions and target-job context for personalized continuation and edits.
- Wrapped file parsing, AI rewriting, LaTeX compilation, PDF export, public sharing and subscription checks as Flask Agent tools, then built a React + Vite conversational editor with PDF preview.

**Result:** Served hundreds of job-search users after launch

---

## RoboMaster Robot Computer Vision Algorithms
**2022.11 - 2025.04** | Vision Team Lead & Project Lead

**Tech Stack:** C++, OpenCV, ROS, PnP Pose Estimation, Kalman Filter, Camera Calibration, Industrial Camera, MiniPC, Git

### Work Scope
- Led the RoboMaster robot auto-aim vision system, covering armor-plate detection, target selection, angle solving, prediction filtering and MiniPC-STM32 integration.
- Built a traditional ROS and OpenCV armor-plate recognition pipeline using color-channel differencing, morphological dilation, contour extraction, ellipse fitting, light-bar filtering and armor matching.
- Designed armor scoring and target-selection strategies using armor area, target priority and distance from the previous-frame target for candidate ranking and tracking.
- Implemented AngleSolver with camera intrinsics, distortion parameters, solvePnP / PinHole models, muzzle-camera offset and ballistic gravity compensation for yaw, pitch and distance solving.
- Introduced Kalman Filter prediction and correction for armor center points to reduce target jumps, short-term target loss and image jitter in gimbal control.
- Handled Linux serial communication and electrical integration with termios, yaw / pitch frame design, sign bits, decimal fields and fire flags for realtime STM32 gimbal control.

**Result:** Won multiple RoboMaster awards across infantry combat and 3V3 competitions

**GitHub:** [notos-rm-autoaim](https://github.com/lizuju/notos-rm-autoaim)

---

## TAAC 2026 Tencent Advertising Algorithm Competition
**2026.04 - 2026.05** | Algorithm Developer

**Tech Stack:** Python, PyTorch, Transformer, Recommender Systems, CTR/CVR Prediction, AUC Optimization, Parquet, Feature Engineering, Focal Loss, Git

### Work Scope
- Built PyTorch conversion-rate prediction models for advertising recommendation, modeling user features, item features, behavior sequences and time features.
- Handled Parquet training data ingestion, schema alignment, padding, sequence truncation and feature processing for user sparse, item sparse, user dense and multi-path behavior inputs.
- Introduced RankMixer NS Tokenizer, MultiSeqQueryGenerator and MultiSeqHyFormerBlock modules to model interactions among user sparse features, item sparse features and behavior sequences.
- Designed dense group projectors and gate fusion for semantically mixed user dense features, grouping features such as dense 61, 87, 62-66 and 89-91 into a fused user dense token.
- Improved Public AUC from 0.806617 to 0.830964 by adding global time features, tuning Focal Loss, improving step-level validation and checkpoint selection, and documenting 35 experiment rounds.

**Result:** Ranked 114th in the Tencent Advertising Algorithm Competition, Top 7%

**GitHub:** [TAAC-2026](https://github.com/lizuju/TAAC-2026)

---

## YOLOv5 Garbage Classification System
**2024.02 - 2025.03** | Full-stack Developer & Project Lead

**Tech Stack:** Python, Flask, Vue, MySQL, YOLOv5, CLIP, Milvus, Git

### Work Scope
- Designed the YOLOv5 garbage recognition architecture, changing fixed-category detection into an object-detection plus semantic-vector retrieval flow to decouple the detector from the category library.
- Used YOLOv5 for object localization and cropping, then combined CLIP embeddings to encode garbage images into high-dimensional semantic vectors for similarity matching.
- Designed a Milvus vector retrieval module and garbage fingerprint library, using TopK nearest-neighbor search and similarity ranking for category decisions and new-category sample insertion.
- Wrapped detection, embedding extraction and vector retrieval APIs with Flask, managed users and records with MySQL, and built image recognition, batch detection and history management in Vue.

**Result:** Won first prize in the national Chuanzhi Cup IT Skills Competition
