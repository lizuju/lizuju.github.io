<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# 🚀 Gavin Lee's (Lizuju) Portfolio

Welcome to the source code of my personal portfolio website! This project is a uniquely designed, lightweight, and modern portfolio built to showcase my academic journey, software engineering skills, project experience, and competition awards. 

You can view the live site here: [lizuju.github.io](https://lizuju.github.io/)

---

## ✨ Features

- **Modern Glassmorphism UI:** A sleek, transparent, and blurry design language powered by advanced vanilla CSS (backdrop-filter) and smooth dynamic gradients.
- **Dynamic Content Loading:** Uses JavaScript to dynamically fetch and render Markdown files. Updating the website is as simple as pushing a new `.md` file!
- **Bilingual Support (i18n):** Flawless native translation between English and Simplified Chinese for all categories, navigation elements, and the contents within the portfolio itself.
- **Fully Responsive Layout:** Optimized from desktop dual-column layouts all the way down to mobile viewports with a dedicated mobile drawer menu.
- **Contact Modal:** A beautiful popup contact interface containing my email and phone info, accessible from the main navigation.
- **Zero-Dependency Core:** Built using standard web capabilities (HTML/CSS/JS) with only lightweight plugins (`marked.js`, `highlight.js`, `tocbot`) loaded via CDN.

## 📂 Project Structure (The 4 Pillars)

The core content of my portfolio is split into four distinct Markdown folders:

- 🎓 **`education/`**: Academic background, National Scholarships, GPA, and trilingual capabilities.
- 💻 **`technical-skills/`**: Expertise in C++, Python, Computer Vision, Full-Stack Development, and Robotics.
- 📋 **`projects/`**: Three major systems led by me: RoboMaster Vision System, Inventory Management System, and Garbage Classification AI.
- 🏆 **`awards/`**: 30+ awards across Mathematical Modeling (MCM M Prize), Robotics, and national-level entrepreneurship projects.

## 🛠️ Local Development

If you want to run this site locally:

1. Clone the repository:
   ```bash
   git clone https://github.com/lizuju/lizuju.github.io.git
   cd lizuju.github.io
   ```

2. Start a local server:
   ```bash
   # If you use Node.js
   npm run dev

   # Or if you prefer Python
   python3 -m http.server 3090
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3090/docs/
   ```

## 📝 How to Update Content
To update what the website displays, you do **not** need to edit the HTML. Simply edit the Markdown files located within the category folders (e.g., `projects/SKILL.md` for English or `projects/SKILL.zh-CN.md` for Chinese).

## 📄 License
This project is licensed under the MIT License. Feel free to explore the code!