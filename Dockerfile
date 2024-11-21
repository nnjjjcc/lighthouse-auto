# 使用特定版本的 Node.js 镜像作为基础镜像
FROM node:18.0.0

# 设置工作目录
WORKDIR /data/workspace/

# 复制项目文件
COPY ./ ./

# 安装必要的依赖
RUN apt-get update && \
  apt-get install -yq chromium fonts-wqy-zenhei && \
  fc-cache -vf && \
  export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true && \
  export PUPPETEER_SKIP_DOWNLOAD=true && \
  ln -s $(which chromium) /data/workspace/chromium && \
  npm install -g pnpm whistle && \
  w2 i @tencent/whistle.polaris && \
  pnpm install && \
  npx lerna run build --scope lighthouse-trigger

# 设置 Puppeteer 的 Chromium 路径
ENV PUPPETEER_EXECUTABLE_PATH /data/workspace/chromium

# 暴露 Whistle 代理端口
EXPOSE 8899

# 运行跑分脚本
ENTRYPOINT [ "node", "/data/workspace/runTasks.js" ]