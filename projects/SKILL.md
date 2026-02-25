# Project Experience

---

## RoboMaster Robot Computer Vision Algorithm Development
**2022.11 - 2025.04** | Vision Team Leader & Project Lead

**Tech Stack:** C++, OpenCV, YOLOv5, Linux, CUDA, Embedded Development (MiniPC), Industrial Camera, Pose Estimation, Model Quantization & Inference Optimization, Git

### Work Description
- As Vision Team Leader and Project Lead, responsible for the overall design, development and testing of the robot's automatic aiming and shooting system, leading the vision architecture and algorithm implementation.
- Built a complete visual processing pipeline based on OpenCV (denoising, filtering, image enhancement, etc.), combined with YOLOv5 for multi-category object detection and real-time tracking. Completed industrial camera calibration, distortion correction, and exposure/gain adjustment to improve recognition accuracy and system robustness in complex industrial environments.
- Responsible for integrating the vision system with the electronic control system. Designed multi-sensor data acquisition and fusion solutions (IMU, encoder, LiDAR) to achieve motion pose estimation and path planning algorithms, ensuring precise positioning and stable control of the robot.
- Completed algorithm porting and performance optimization on MiniPC/embedded platforms through CUDA acceleration, model quantization and inference optimization to improve system real-time performance and resource utilization.
- Used Git for code management and team collaboration. Through algorithm complexity optimization, data structure improvements and parallel computing, significantly improved system response speed and control accuracy, promoting project modularization and engineering implementation.
- Coordinated mechanical, electronic control and other module development schedules, helping the team achieve excellent results in RoboMaster competitions.

**Project Outcome:** Won multiple awards in two RoboMaster Mecha Master Competitions (Infantry Combat & 3V3 Combat)

---

## Machine Vision & Radar Modeling Inventory Management System
**2023.09 - 2024.06** | Full-Stack Developer & Project Lead

**Tech Stack:** Python, Flask, Vue, MySQL, OpenCV, YOLOv5, Multi-sensor Data Fusion, Zbar, Git

### Work Description
- Responsible for the overall architecture design and core function development of the inventory management system based on machine vision and radar modeling. Built a front-end/back-end separated system framework for automatic identification and counting of warehouse goods.
- Built image preprocessing pipeline based on OpenCV (denoising, perspective correction, region cropping, etc.), combined with YOLOv5 for cargo object detection and category recognition, completing real-time inventory and anomaly detection functions.
- Combined radar data for spatial modeling and distance measurement, designed vision and radar data fusion logic to improve recognition accuracy and inventory statistics reliability in occlusion scenarios.
- Built backend services using Flask, implementing inventory management, data storage and RESTful API design. Used MySQL for database modeling and index optimization to improve query efficiency and system stability.
- Built a visual management interface using Vue, implementing dynamic inventory display, statistical analysis and alert notification functions. Completed front-end/back-end interface integration and system deployment.
- Optimized detection models and system performance through inference acceleration and data structure improvements to ensure efficient and stable operation in warehouse scenarios.

**Project Outcome:** Won provincial-level completion award in the National College Student Innovation and Entrepreneurship Competition

---

## YOLOv5 Garbage Classification Recognition System
**2024.02 - 2025.03** | Full-Stack Developer & Project Lead

**Tech Stack:** Python, Flask, Vue, MySQL, YOLOv5, CLIP, Milvus, Git

### Work Description
- Responsible for the overall architecture design and core function development of the YOLOv5 garbage recognition system. Innovatively transformed the traditional "fixed classification detection" into a "feature embedding + vector search" architecture, building an extensible garbage recognition platform that decouples models from categories.
- Built a general object detection pipeline based on YOLOv5, responsible only for object localization and cropping. Introduced pre-trained deep networks (CLIP) for feature embedding extraction, converting garbage images into high-dimensional semantic vector representations to improve feature expression and generalization capabilities.
- Designed and built a vector retrieval system, combined with Milvus to create a "garbage fingerprint library", enabling efficient similarity matching and nearest neighbor search for massive feature vectors, transforming category determination into a vector similarity ranking problem.
- Built a dynamically extensible recognition mechanism - when adding new garbage types, no retraining of detection models is needed; simply adding sample vectors to the database completes the system expansion, significantly reducing model iteration costs and training overhead.
- Built backend services using Flask, encapsulating detection and vector retrieval interfaces. Used MySQL for user and record management. Implemented Vue-based frontend for recognition display and history management, completing front-end/back-end separated architecture design and system deployment.
- Optimized vector retrieval efficiency and inference pipeline through index structure optimization and batch feature computation to improve system response speed, achieving engineering-level scalable deployment.

**Project Outcome:** Won First Prize in the Chuanzhi Cup National IT Skills Competition
