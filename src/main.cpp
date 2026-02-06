#include <imgui.h>
#include "backends/imgui_impl_glfw.h"
#include "backends/imgui_impl_opengl3.h"
#include <GLFW/glfw3.h>
#include <iostream>
#include <string>
#include <thread>
#include <nlohmann/json.hpp>
#include <httplib.h>

static void glfw_error_callback(int error, const char* description)
{
    fprintf(stderr, "Glfw Error %d: %s\n", error, description);
}

int main(int argc, char** argv)
{
    // Setup window
    glfwSetErrorCallback(glfw_error_callback);
    if (!glfwInit())
        return 1;

    // Decide GL+GLSL versions
    const char* glsl_version = "#version 130";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);

    GLFWwindow* window = glfwCreateWindow(1280, 720, "HalloChat (ImGui C++)", NULL, NULL);
    if (window == NULL)
        return 1;
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    // Setup Dear ImGui context
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO(); (void)io;

    // Setup Dear ImGui style
    ImGui::StyleColorsDark();

    // Setup Platform/Renderer backends
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glsl_version);

    bool show_demo_window = false;

    // Login state
    static char username[64] = "";
    static char password[64] = "";
    bool logging = false;
    std::string login_status;

    while (!glfwWindowShouldClose(window))
    {
        glfwPollEvents();

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        ImGui::Begin("HalloChat 登录");
        ImGui::InputText("用户名", username, IM_ARRAYSIZE(username));
        ImGui::InputText("密码", password, IM_ARRAYSIZE(password), ImGuiInputTextFlags_Password);

        if (ImGui::Button("登录") && !logging) {
            logging = true;
            login_status = "正在登录...";

            std::string user = std::string(username);
            std::string pass = std::string(password);

            std::thread([&]() {
                try {
                    httplib::Client cli("http://localhost:7932");
                    nlohmann::json body;
                    body["username"] = user;
                    body["password"] = pass;
                    auto res = cli.Post("/api/auth/login", body.dump(), "application/json");
                    if (res && res->status == 200) {
                        auto j = nlohmann::json::parse(res->body);
                        if (j.value("success", false)) {
                            login_status = "登录成功";
                        } else {
                            login_status = j.value("message", "登录失败");
                        }
                    } else if (res) {
                        login_status = "HTTP 错误: " + std::to_string(res->status);
                    } else {
                        login_status = "无法连接到服务器";
                    }
                } catch (const std::exception& e) {
                    login_status = std::string("异常: ") + e.what();
                }
                logging = false;
            }).detach();
        }

        ImGui::SameLine();
        if (ImGui::Button("退出"))
            glfwSetWindowShouldClose(window, GLFW_TRUE);

        ImGui::TextWrapped("%s", login_status.c_str());
        ImGui::End();

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

    // Cleanup
    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();

    glfwDestroyWindow(window);
    glfwTerminate();

    return 0;
}
