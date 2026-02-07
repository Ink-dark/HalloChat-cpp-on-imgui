cmake_minimum_required(VERSION 3.14)
project(hallochat-imgui-cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 设置策略以处理新版本 CMake 的兼容性
if(POLICY CMP0077)
  cmake_policy(SET CMP0077 NEW)
endif()

include(FetchContent)

# 首先获取并设置 ZLIB（ixwebsocket 需要这个依赖）
FetchContent_Declare(
  zlib
  GIT_REPOSITORY https://github.com/madler/zlib.git
  GIT_TAG        v1.3.1
)
# 设置 ZLIB 的 CMake 选项
set(SKIP_INSTALL_ALL ON CACHE BOOL "Skip installation" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build static library" FORCE)
FetchContent_MakeAvailable(zlib)

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

# ixwebsocket - 配置选项以禁用 ZLIB 或使用我们提供的 ZLIB
FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG        v11.4.5
)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)

# 选项1：禁用 ixwebsocket 的 ZLIB 支持（如果您的项目不需要压缩）
# set(IXWEBSOCKET_USE_ZLIB OFF CACHE BOOL "Disable ZLIB support" FORCE)

# 选项2：使用我们通过 FetchContent 获取的 ZLIB
set(IXWEBSOCKET_USE_ZLIB ON CACHE BOOL "Enable ZLIB support" FORCE)

FetchContent_MakeAvailable(ixwebsocket)

# 如果 ixwebsocket 没有自动链接 ZLIB，我们需要手动链接
if(IXWEBSOCKET_USE_ZLIB AND TARGET zlibstatic)
    # 确保 ixwebsocket 链接到我们的 ZLIB
    if(TARGET ixwebsocket)
        target_link_libraries(ixwebsocket PRIVATE zlibstatic)
    endif()
endif()

add_executable(hallochat-imgui
  src/main.cpp
)

target_include_directories(hallochat-imgui PRIVATE
  ${imgui_SOURCE_DIR}
  ${imgui_SOURCE_DIR}/backends
  ${cpphttplib_SOURCE_DIR}
)

target_link_libraries(hallochat-imgui PRIVATE
  glfw
  nlohmann_json::nlohmann_json
  ixwebsocket
)

# 如果启用了 ZLIB 支持，也链接到主目标
if(IXWEBSOCKET_USE_ZLIB AND TARGET zlibstatic)
    target_link_libraries(hallochat-imgui PRIVATE zlibstatic)
endif()

if (WIN32)
  target_compile_definitions(hallochat-imgui PRIVATE -DWIN32)
endif()

# Build ImGui sources into a static lib
file(GLOB IMGUI_SRC
  ${imgui_SOURCE_DIR}/*.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp
)

add_library(imgui_lib STATIC ${IMGUI_SRC})
target_include_directories(imgui_lib PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(imgui_lib PUBLIC glfw)

target_link_libraries(hallochat-imgui PRIVATE imgui_lib)

if (WIN32)
  find_package(OpenGL REQUIRED)
  target_link_libraries(hallochat-imgui PRIVATE OpenGL::GL)
else()
  find_package(OpenGL REQUIRED)
  target_link_libraries(hallochat-imgui PRIVATE OpenGL::GL)
endif()
