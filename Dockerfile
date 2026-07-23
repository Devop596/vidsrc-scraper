# 1. استخدام صورة Playwright الرسمية المجهزة بمتصفح Chromium وكل الاعتماديات
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

# 2. تحديد مجلد العمل داخل الـ Container
WORKDIR /app

# 3. نسخ ملفات التعريف وتثبيت الحزم
COPY package*.json ./
RUN npm install

# 4. نسخ باقي كود المشروع
COPY . .

# 5. فتح المنفذ الخارجي المطابق للـ Express Server (4000)
EXPOSE 4000

# 6. أمر تشغيل السيرفر
CMD ["npm", "start"]
