# HalloChat ImGui C++ 客户端

这是一个使用 Dear ImGui 和 C++ 快速搭建的 HalloChat 客户端示例。该示例展示了登录 UI，并通过 HTTP POST 调用现有 Node.js 服务端的 `/api/auth/login` 接口进行登录验证。

构建说明（Windows / Visual Studio）：

1. 创建构建目录并运行 CMake：

```bash
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release
```

2. 运行可执行文件（在 build 输出目录下）。

说明：CMake 使用 FetchContent 下载依赖：GLFW、ImGui、nlohmann/json、cpp-httplib。确保你可以访问 GitHub。
