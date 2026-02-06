#include <imgui.h>
#include "backends/imgui_impl_glfw.h"
#include "backends/imgui_impl_opengl3.h"
#include <GLFW/glfw3.h>
#include <httplib.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct FriendInfo {
    std::string uid;
    std::string username;
};

struct ChatMessage {
    std::string fromUid;
    std::string fromName;
    std::string toUid;
    std::string text;
    bool isPrivate = false;
    long long ts = 0;
};

struct AppState {
    std::string serverUrl = "http://localhost:3001";
    std::string wsPath = "/ws";
    std::string uid;
    std::string username;
    std::string token;
    std::string status;
    std::string wsStatus = "disconnected";
    bool authed = false;
    bool requestPending = false;
    bool wsRunning = false;
    std::string activeChatUid; // empty -> group
    std::vector<FriendInfo> friends;
    std::vector<ChatMessage> messages;
};

static void glfw_error_callback(int error, const char* description)
{
    fprintf(stderr, "Glfw Error %d: %s\n", error, description);
}

static std::string makeWsUrl(const std::string& base, const std::string& path)
{
    std::string url = base;
    if (url.rfind("http://", 0) == 0) {
        url = "ws://" + url.substr(7);
    } else if (url.rfind("https://", 0) == 0) {
        url = "wss://" + url.substr(8);
    }
    if (!path.empty()) {
        if (url.back() == '/' && path.front() == '/') {
            url.pop_back();
        }
        url += path;
    }
    return url;
}

static long long nowMillis()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

static void addMessage(std::vector<ChatMessage>& messages, const ChatMessage& msg)
{
    messages.push_back(msg);
    if (messages.size() > 500) {
        messages.erase(messages.begin(), messages.begin() + 100);
    }
}

int main(int argc, char** argv)
{
    glfwSetErrorCallback(glfw_error_callback);
    if (!glfwInit())
        return 1;

    // macOS needs OpenGL 3.2+ Core Profile for modern contexts
    // (3.0/3.1 may not be supported depending on OS/driver)
    const char* glsl_version = "#version 150";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GL_TRUE);

    GLFWwindow* window = glfwCreateWindow(1280, 720, "HalloChat (ImGui C++)", NULL, NULL);
    if (window == NULL)
        return 1;
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();

    // Load a CJK-capable font on macOS so Chinese doesn't show as "????"
    // Try Hiragino Sans GB first (common on macOS), fallback to STHeiti.
    const char* font1 = "/System/Library/Fonts/Hiragino Sans GB.ttc";
    const char* font2 = "/System/Library/Fonts/STHeiti Light.ttc";
    float fontSize = 18.0f;
    if (io.Fonts->AddFontFromFileTTF(font1, fontSize, NULL, io.Fonts->GetGlyphRangesChineseFull()) == NULL)
    {
        io.FontDefault = io.Fonts->AddFontFromFileTTF(font2, fontSize, NULL, io.Fonts->GetGlyphRangesChineseFull());
    }

    ImGui::StyleColorsDark();

    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glsl_version);

    ix::initNetSystem();

    AppState state;
    std::mutex stateMutex;
    ix::WebSocket ws;

    auto stopWebSocket = [&]() {
        if (!state.wsRunning)
            return;
        ws.stop();
        state.wsRunning = false;
        state.wsStatus = "disconnected";
    };

    auto startWebSocket = [&]() {
        if (state.wsRunning || state.token.empty())
            return;

        state.wsStatus = "connecting";
        std::string wsUrl = makeWsUrl(state.serverUrl, state.wsPath);

        ws.setUrl(wsUrl);
        ws.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
            std::lock_guard<std::mutex> lock(stateMutex);
            if (msg->type == ix::WebSocketMessageType::Open) {
                state.wsStatus = "connected";
                nlohmann::json auth;
                auth["type"] = "auth";
                auth["token"] = state.token;
                ws.send(auth.dump());
                return;
            }
            if (msg->type == ix::WebSocketMessageType::Close) {
                state.wsStatus = "disconnected";
                return;
            }
            if (msg->type != ix::WebSocketMessageType::Message) {
                return;
            }

            nlohmann::json payload;
            try {
                payload = nlohmann::json::parse(msg->str);
            } catch (...) {
                return;
            }

            const std::string type = payload.value("type", "");
            if (type == "system") {
                ChatMessage m;
                m.fromName = "系统";
                m.text = payload.value("message", "");
                m.ts = payload.value("ts", nowMillis());
                addMessage(state.messages, m);
                return;
            }

            if (type == "message") {
                ChatMessage m;
                m.fromUid = payload.value("uid", "");
                m.fromName = payload.value("name", "");
                m.text = payload.value("text", "");
                m.ts = payload.value("ts", nowMillis());
                addMessage(state.messages, m);
                return;
            }

            if (type == "private") {
                ChatMessage m;
                m.fromUid = payload.value("fromUid", "");
                m.fromName = payload.value("fromName", "");
                m.toUid = payload.value("toUid", "");
                m.text = payload.value("text", "");
                m.ts = payload.value("ts", nowMillis());
                m.isPrivate = true;
                addMessage(state.messages, m);
                return;
            }
        });

        ws.start();
        state.wsRunning = true;
    };

    auto refreshFriends = [&]() {
        if (!state.authed || state.requestPending)
            return;

        state.requestPending = true;
        std::string serverUrl = state.serverUrl;
        std::string token = state.token;

        std::thread([&, serverUrl, token]() {
            httplib::Client cli(serverUrl.c_str());
            httplib::Headers headers = { {"Authorization", "Bearer " + token} };
            auto res = cli.Get("/api/friends/list", headers);
            std::lock_guard<std::mutex> lock(stateMutex);
            if (res && res->status == 200) {
                try {
                    auto j = nlohmann::json::parse(res->body);
                    if (j.value("success", false)) {
                        state.friends.clear();
                        for (auto& item : j["friends"]) {
                            FriendInfo f;
                            f.uid = item.value("uid", "");
                            f.username = item.value("username", "");
                            if (!f.uid.empty())
                                state.friends.push_back(f);
                        }
                        state.status = "好友列表已刷新";
                    }
                } catch (...) {
                    state.status = "好友列表解析失败";
                }
            } else {
                state.status = "获取好友列表失败";
            }
            state.requestPending = false;
        }).detach();
    };

    bool show_demo_window = false;

    static char serverUrlBuf[256] = "http://localhost:3001";
    static char loginUserBuf[64] = "";
    static char loginPassBuf[64] = "";
    static char registerUserBuf[64] = "";
    static char registerPassBuf[64] = "";
    static char friendUidBuf[64] = "";
    static char chatInputBuf[512] = "";

    while (!glfwWindowShouldClose(window))
    {
        glfwPollEvents();

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        AppState view;
        {
            std::lock_guard<std::mutex> lock(stateMutex);
            view = state;
        }
        ImGuiViewport* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->WorkPos, ImGuiCond_Always);
        ImGui::SetNextWindowSize(viewport->WorkSize, ImGuiCond_Always);
        ImGuiWindowFlags windowFlags = ImGuiWindowFlags_NoResize |
                                       ImGuiWindowFlags_NoMove |
                                       ImGuiWindowFlags_NoCollapse |
                                       ImGuiWindowFlags_NoTitleBar |
                                       ImGuiWindowFlags_NoScrollbar |
                                       ImGuiWindowFlags_NoScrollWithMouse;
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(16, 16));
        ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0f);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
        ImGui::Begin("##MainWindow", nullptr, windowFlags);

        ImGui::Text("服务器地址");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(360);
        ImGui::InputText("##server", serverUrlBuf, IM_ARRAYSIZE(serverUrlBuf));
        ImGui::SameLine();
        if (ImGui::Button("应用")) {
            std::lock_guard<std::mutex> lock(stateMutex);
            state.serverUrl = std::string(serverUrlBuf);
            state.status = "服务器地址已更新";
        }

        ImGui::Separator();

        if (!view.authed) {
            if (ImGui::BeginTabBar("AuthTabs")) {
                if (ImGui::BeginTabItem("登录")) {
                    ImGui::InputText("用户名", loginUserBuf, IM_ARRAYSIZE(loginUserBuf));
                    ImGui::InputText("密码", loginPassBuf, IM_ARRAYSIZE(loginPassBuf), ImGuiInputTextFlags_Password);
                    if (ImGui::Button("登录") && !view.requestPending) {
                        {
                            std::lock_guard<std::mutex> lock(stateMutex);
                            state.requestPending = true;
                        }
                        std::string serverUrl = view.serverUrl;
                        std::string user = loginUserBuf;
                        std::string pass = loginPassBuf;
                        std::thread([&, serverUrl, user, pass]() {
                            httplib::Client cli(serverUrl.c_str());
                            nlohmann::json body;
                            body["username"] = user;
                            body["password"] = pass;
                            auto res = cli.Post("/api/auth/login", body.dump(), "application/json");
                            std::lock_guard<std::mutex> lock(stateMutex);
                            if (res && res->status == 200) {
                                try {
                                    auto j = nlohmann::json::parse(res->body);
                                    if (j.value("success", false)) {
                                        state.authed = true;
                                        state.uid = j.value("uid", "");
                                        state.username = j.value("username", "");
                                        state.token = j.value("token", "");
                                        state.status = "登录成功";
                                        state.activeChatUid.clear();
                                    } else {
                                        state.status = j.value("message", "登录失败");
                                    }
                                } catch (...) {
                                    state.status = "登录响应解析失败";
                                }
                            } else {
                                state.status = "登录失败或无法连接";
                            }
                            state.requestPending = false;
                        }).detach();
                    }
                    ImGui::EndTabItem();
                }

                if (ImGui::BeginTabItem("注册")) {
                    ImGui::InputText("用户名", registerUserBuf, IM_ARRAYSIZE(registerUserBuf));
                    ImGui::InputText("密码", registerPassBuf, IM_ARRAYSIZE(registerPassBuf), ImGuiInputTextFlags_Password);
                    if (ImGui::Button("注册") && !view.requestPending) {
                        {
                            std::lock_guard<std::mutex> lock(stateMutex);
                            state.requestPending = true;
                        }
                        std::string serverUrl = view.serverUrl;
                        std::string user = registerUserBuf;
                        std::string pass = registerPassBuf;
                        std::thread([&, serverUrl, user, pass]() {
                            httplib::Client cli(serverUrl.c_str());
                            nlohmann::json body;
                            body["username"] = user;
                            body["password"] = pass;
                            auto res = cli.Post("/api/auth/register", body.dump(), "application/json");
                            std::lock_guard<std::mutex> lock(stateMutex);
                            if (res && res->status == 200) {
                                try {
                                    auto j = nlohmann::json::parse(res->body);
                                    if (j.value("success", false)) {
                                        state.authed = true;
                                        state.uid = j.value("uid", "");
                                        state.username = j.value("username", "");
                                        state.token = j.value("token", "");
                                        state.status = "注册成功";
                                        state.activeChatUid.clear();
                                    } else {
                                        state.status = j.value("message", "注册失败");
                                    }
                                } catch (...) {
                                    state.status = "注册响应解析失败";
                                }
                            } else {
                                state.status = "注册失败或无法连接";
                            }
                            state.requestPending = false;
                        }).detach();
                    }
                    ImGui::EndTabItem();
                }
                ImGui::EndTabBar();
            }
        } else {
            ImGui::Text("当前用户: %s", view.username.c_str());
            ImGui::SameLine();
            ImGui::TextDisabled("UID: ");
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.30f, 0.65f, 1.00f, 1.00f));
            ImGui::Selectable(view.uid.c_str(), false, ImGuiSelectableFlags_SpanAllColumns);
            ImGui::PopStyleColor();
            if (ImGui::IsItemClicked()) {
                ImGui::SetClipboardText(view.uid.c_str());
                std::lock_guard<std::mutex> lock(stateMutex);
                state.status = "UID 已复制";
            }
            ImGui::SameLine();
            ImGui::Text("WS: %s", view.wsStatus.c_str());

            if (ImGui::Button("刷新好友") && !view.requestPending) {
                refreshFriends();
            }
            ImGui::SameLine();
            if (ImGui::Button("退出登录")) {
                stopWebSocket();
                std::lock_guard<std::mutex> lock(stateMutex);
                state.authed = false;
                state.token.clear();
                state.uid.clear();
                state.username.clear();
                state.friends.clear();
                state.messages.clear();
                state.activeChatUid.clear();
                state.status = "已退出";
            }

            ImGui::Separator();
            ImGui::BeginChild("Left", ImVec2(260, 0), false);
            ImGui::Text("聊天列表");
            if (ImGui::Selectable("大群", view.activeChatUid.empty())) {
                std::lock_guard<std::mutex> lock(stateMutex);
                state.activeChatUid.clear();
            }
            ImGui::Separator();
            ImGui::Text("好友");
            for (const auto& f : view.friends) {
                bool selected = (view.activeChatUid == f.uid);
                std::string label = f.username + "##" + f.uid;
                if (ImGui::Selectable(label.c_str(), selected)) {
                    std::lock_guard<std::mutex> lock(stateMutex);
                    state.activeChatUid = f.uid;
                }
            }
            ImGui::Separator();
            ImGui::InputText("好友UID", friendUidBuf, IM_ARRAYSIZE(friendUidBuf));
            if (ImGui::Button("添加好友") && !view.requestPending) {
                {
                    std::lock_guard<std::mutex> lock(stateMutex);
                    state.requestPending = true;
                }
                std::string serverUrl = view.serverUrl;
                std::string token = view.token;
                std::string friendUid = friendUidBuf;
                std::thread([&, serverUrl, token, friendUid]() {
                    httplib::Client cli(serverUrl.c_str());
                    httplib::Headers headers = { {"Authorization", "Bearer " + token} };
                    nlohmann::json body;
                    body["uid"] = friendUid;
                    auto res = cli.Post("/api/friends/add", headers, body.dump(), "application/json");
                    std::lock_guard<std::mutex> lock(stateMutex);
                    if (res && res->status == 200) {
                        try {
                            auto j = nlohmann::json::parse(res->body);
                            if (j.value("success", false)) {
                                auto f = j["friend"];
                                FriendInfo info;
                                info.uid = f.value("uid", "");
                                info.username = f.value("username", "");
                                state.friends.push_back(info);
                                state.status = "好友已添加";
                            } else {
                                state.status = j.value("message", "添加失败");
                            }
                        } catch (...) {
                            state.status = "添加响应解析失败";
                        }
                    } else {
                        state.status = "添加好友失败";
                    }
                    state.requestPending = false;
                }).detach();
            }
            ImGui::EndChild();

            ImGui::SameLine();

            ImGui::BeginChild("Right", ImVec2(0, 0), false);
            std::string chatTitle = view.activeChatUid.empty() ? "大群聊天" : ("私聊: " + view.activeChatUid);
            ImGui::Text("%s", chatTitle.c_str());
            ImGui::Separator();

            ImGui::BeginChild("Messages", ImVec2(0, -60), false);
            for (const auto& msg : view.messages) {
                bool show = false;
                if (view.activeChatUid.empty()) {
                    show = !msg.isPrivate;
                } else {
                    show = msg.isPrivate &&
                           ((msg.fromUid == view.activeChatUid && msg.toUid == view.uid) ||
                            (msg.fromUid == view.uid && msg.toUid == view.activeChatUid));
                }
                if (!show) continue;

                std::string name = msg.fromName.empty() ? msg.fromUid : msg.fromName;
                if (msg.fromName == "系统") {
                    ImGui::TextDisabled("[系统] %s", msg.text.c_str());
                } else if (msg.isPrivate) {
                    ImGui::Text("[私聊]%s: %s", name.c_str(), msg.text.c_str());
                } else {
                    ImGui::Text("%s: %s", name.c_str(), msg.text.c_str());
                }
            }
            ImGui::EndChild();

            ImGui::Separator();
            ImGui::SetNextItemWidth(-80);
            bool sendNow = ImGui::InputText("##chatinput", chatInputBuf, IM_ARRAYSIZE(chatInputBuf), ImGuiInputTextFlags_EnterReturnsTrue);
            ImGui::SameLine();
            if (ImGui::Button("发送") || sendNow) {
                std::string text = chatInputBuf;
                if (!text.empty() && view.wsRunning) {
                    nlohmann::json payload;
                    if (view.activeChatUid.empty()) {
                        payload["type"] = "message";
                        payload["text"] = text;
                    } else {
                        payload["type"] = "private";
                        payload["toUid"] = view.activeChatUid;
                        payload["text"] = text;
                    }
                    ws.send(payload.dump());
                    chatInputBuf[0] = '\0';
                }
            }
            ImGui::EndChild();
        }

        ImGui::Separator();
        ImGui::TextWrapped("状态: %s", view.status.c_str());

        if (view.authed && !view.wsRunning && !view.token.empty()) {
            startWebSocket();
            refreshFriends();
        }

        ImGui::End();
        ImGui::PopStyleVar(3);

        if (show_demo_window)
            ImGui::ShowDemoWindow(&show_demo_window);

        ImGui::Render();
        int display_w, display_h;
        glfwGetFramebufferSize(window, &display_w, &display_h);
        glViewport(0, 0, display_w, display_h);
        glClearColor(0.45f, 0.55f, 0.60f, 1.00f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

        glfwSwapBuffers(window);
    }

    stopWebSocket();
    ix::uninitNetSystem();

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();

    glfwDestroyWindow(window);
    glfwTerminate();

    return 0;
}
