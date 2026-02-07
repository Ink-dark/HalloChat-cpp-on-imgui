cmake_minimum_required(VERSION 3.14)
project(hallochat-imgui-cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# ZLIB - 首先获取
FetchContent_Declare(
  zlib
  GIT_REPOSITORY https://github.com/madler/zlib.git
  GIT_TAG        v1.3.1
)
FetchContent_MakeAvailable(zlib)

# 在 ixwebsocket 查找 ZLIB 之前设置相关变量
set(ZLIB_FOUND TRUE)
set(ZLIB_INCLUDE_DIRS ${zlib_SOURCE_DIR} ${zlib_BINARY_DIR})
set(ZLIB_LIBRARIES zlibstatic)
set(ZLIB_VERSION_STRING "1.3.1")

# GLFW
FetchContent_Declare(
  glfw
  GIT_REPOSITORY https://github.com/glfw/glfw.git
  GIT_TAG        3.3.8
)
FetchContent_MakeAvailable(glfw)

# ImGui
FetchContent_Declare(
  imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG        v1.90.2
)
FetchContent_MakeAvailable(imgui)

# nlohmann json
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.2
)
FetchContent_MakeAvailable(nlohmann_json)

# cpp-httplib (header-only)
FetchContent_Declare(
  cpphttplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.10.9
)
FetchContent_MakeAvailable(cpphttplib)

# ixwebsocket - 禁用其内部的 ZLIB 查找
FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG        v11.4.5
)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)

# 关键修改：在配置 ixwebsocket 之前设置 ZLIB 变量
FetchContent_GetProperties(ixwebsocket)
if(NOT ixwebsocket_POPULATED)
  FetchContent_Populate(ixwebsocket)
  
  # 修改 ixwebsocket 的 CMakeLists.txt 来使用我们的 ZLIB
  file(READ ${ixwebs
