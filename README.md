# 🌐 Web-Scout: Autonomous CLI & Web Agent



Web-Scout is a fully autonomous, TypeScript-based AI agent powered by **Google Gemini 2.5 Flash**. It bridges the gap between your local terminal and the internet. Built entirely from scratch without heavy frameworks, it uses a custom **ReAct (Reason + Act)** loop to execute terminal commands, visually browse the web, and solve complex, multi-step prompts.



## ✨ Key Features



* **💻 Terminal Control:** Executes local shell commands to read files, manage directories, or check system states.

* **🛡️ Human-in-the-Loop (HITL):** Built-in security pauses before executing any CLI command, ensuring the agent doesn't accidentally run destructive scripts.

* **🌍 Visual Web Browsing:** Integrates **Playwright** to open a real browser instance, navigate URLs, search the web (bypassing CAPTCHAs via DuckDuckGo), and click specific elements.

* **🧠 Self-Healing:** If a CLI command fails or an HTML element is missing, the agent reads the error message and automatically formulates a new plan.

* **🗣️ Native Voice (TTS):** Uses your operating system's native text-to-speech engine (`say`, `PowerShell`, or `espeak`) to speak its thought process and answers out loud.



## 🏗️ How It Works (The ReAct Loop)



Instead of immediately generating a text response, Web-Scout enters a reasoning loop:

1. **Reason:** The LLM analyzes your prompt and decides which tool it needs.

2. **Act:** It outputs a JSON function call (e.g., `execute_command` or `search_web`).

3. **Observe:** The TypeScript controller intercepts the call, runs the physical action (via Playwright or Node `child_process`), and feeds the result back to the LLM.

4. **Repeat:** The agent continues this cycle until it has gathered enough information to fulfill your original request.



## 🚀 Getting Started



### Prerequisites

* **Node.js** (v18+ recommended)

* A **Google Gemini API Key** (Free tier works perfectly)



