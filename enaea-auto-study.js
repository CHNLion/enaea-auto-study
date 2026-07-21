// ==UserScript==
// @name         ENAEA自动刷课助手v1.2
// @namespace    https://greasyfork.org/
// @version      1.2
// @description  中国教育干部网络学院(enaea.edu.cn)自动刷课工具 - 自动连续刷课、多页检测、倍速播放、自动静音、智能跳转（修复换集后倍速失效问题）
// @author       Liontooth
// @match        https://study.enaea.edu.cn/*
// @match        https://*.ttcdw.cn/*
// @match        https://*.ertcloud.net/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @homepage     https://github.com/chnlion/enaea-auto-study
// @supportURL   https://github.com/chnlion/enaea-auto-study/issues
// ==/UserScript==

(function() {
    'use strict';

    console.log('🚀 ENAEA自动刷课助手已启动 (v1.2 修复版)');

    // ==================== 配置项 ====================
    let TARGET_SPEED = parseInt(localStorage.getItem('enaea_target_speed')) || 4;
    let AUTO_MUTE = localStorage.getItem('enaea_auto_mute') !== 'false';
    let AUTO_JUMP = true; // 播放页自动跳转到未完成课程
    let AUTO_SELECT_COURSE = true; // 列表页自动选择未完成课程
    let AUTO_CONTINUOUS = localStorage.getItem('enaea_auto_continuous') !== 'false'; // 自动连续刷课
    let CHECK_INTERVAL = parseInt(localStorage.getItem('enaea_check_interval')) || 15; // 检测间隔（秒）
    let MAX_CONTINUOUS_COUNT = 50; // 最大连续刷课次数

    // 【修复】不再用 WeakSet 来"跳过已处理视频"，因为同一个 <video> 元素
    // 在切换到下一集时会被播放器复用（只是换了 src），而浏览器在加载新资源时
    // 会在内部把 playbackRate 重置为 defaultPlaybackRate（1倍速），这个重置
    // 不会经过我们劫持的 setter，所以旧的"已处理则跳过"逻辑会导致脚本再也
    // 不会重新设置倍速，直到用户手动切换一次倍速（那次手动操作会显式触发
    // setter）。现在只用一个 WeakSet 来避免重复绑定监听器，倍速本身每次都强制重设。
    let listenerBoundVideos = new WeakSet();
    let checkTimer = null;
    let lastCheckTime = 0;

    // ==================== 核心功能：劫持播放速度 ====================

    function hijackPlaybackRate() {
        const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
            get: function() {
                return originalDescriptor.get.call(this);
            },
            set: function(value) {
                originalDescriptor.set.call(this, TARGET_SPEED);
                console.log(`🎯 拦截并强制设置播放速度为${TARGET_SPEED}倍速`);
            },
            configurable: true
        });
    }

    // 【修复】始终强制应用倍速/静音，不再因为"之前处理过"而跳过。
    // 这是幂等操作，重复调用没有副作用，但能确保换集后（浏览器内部把
    // playbackRate 重置为 1）我们能立刻纠正回来。
    function setVideoSpeed(video) {
        if (!video) return false;
        try {
            if (video.playbackRate !== TARGET_SPEED) {
                video.playbackRate = TARGET_SPEED;
                console.log(`✅ 视频播放速度已设置为${TARGET_SPEED}倍速`);
            }
            if (AUTO_MUTE) {
                if (!video.muted || video.volume !== 0) {
                    video.muted = true;
                    video.volume = 0;
                    console.log('🔇 视频已静音');
                }
            }
            attachPerVideoListeners(video);
            return true;
        } catch (e) {
            console.error('❌ 设置视频速度失败:', e);
            return false;
        }
    }

    // 【新增】给每个视频元素只绑定一次这些"换集/加载新资源"相关事件，
    // 一旦触发就立刻重新强制设定倍速，弥补浏览器内部静默重置的问题。
    function attachPerVideoListeners(video) {
        if (listenerBoundVideos.has(video)) return;
        listenerBoundVideos.add(video);

        const reassert = (label) => {
            // 用 originalDescriptor 之外的当前值判断，避免重复打印日志；
            // 直接调用 setVideoSpeed 即可，内部已做幂等判断。
            setVideoSpeed(video);
            console.log(`🔁 [${label}] 事件触发，已重新校验倍速/静音状态`);
        };

        // loadstart: 开始加载新资源时触发（包括切换到下一集/换 src）
        video.addEventListener('loadstart', () => reassert('loadstart'));
        // emptied: 媒体元素的资源被清空时触发（通常发生在换 src 之前）
        video.addEventListener('emptied', () => reassert('emptied'));
        // loadedmetadata / canplay: 新资源的元数据/可播放状态就绪
        video.addEventListener('loadedmetadata', () => reassert('loadedmetadata'));
        video.addEventListener('canplay', () => reassert('canplay'));
        // play: 每次开始播放时兜底校验一次
        video.addEventListener('play', () => reassert('play'));
        // ratechange: 如果 playbackRate 被以任何方式改变（包括浏览器内部重置），
        // 这个事件通常仍会触发，作为最后一道保险。加一个防抖/防递归判断。
        let reassertingFromRateChange = false;
        video.addEventListener('ratechange', () => {
            if (reassertingFromRateChange) return;
            if (video.playbackRate === TARGET_SPEED) return;
            reassertingFromRateChange = true;
            reassert('ratechange');
            setTimeout(() => { reassertingFromRateChange = false; }, 0);
        });
    }

    function setAllVideos() {
        const videos = document.querySelectorAll('video');
        let count = 0;
        videos.forEach(video => {
            if (setVideoSpeed(video)) {
                count++;
            }
        });
        if (count > 0) {
            console.log(`🎬 找到并校验了 ${count} 个视频`);
        }
    }

    // ==================== MutationObserver监控新增视频 ====================

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.tagName === 'VIDEO') {
                        setVideoSpeed(node);
                    } else if (node.querySelectorAll) {
                        const videos = node.querySelectorAll('video');
                        videos.forEach(video => setVideoSpeed(video));
                    }
                });
            });
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        console.log('👀 视频监控器已启动');
    }

    // ==================== 播放页：自动识别并跳转到未完成课程 ====================

    function findAndJumpToUnfinishedCourse() {
        console.log('🔍 正在查找未完成的课程...');
        console.log('📍 当前URL:', window.location.href);
        console.log('📍 document.readyState:', document.readyState);
        console.log('📍 document.body存在:', !!document.body);

        let allCourses = [];

        if (!document.body) {
            console.log('⚠️ 页面body还未加载，延迟1秒后重试...');
            setTimeout(findAndJumpToUnfinishedCourse, 1000);
            return false;
        }

        let courseContents = document.querySelectorAll('.cvtb-MCK-course-content, .cvtb-NCK-course-content');
        console.log(`📌 方法1：找到 ${courseContents.length} 个课程元素`);

        if (courseContents.length === 0) {
            courseContents = document.querySelectorAll('[class*="course-content"]');
            console.log(`📌 方法2：找到 ${courseContents.length} 个包含 course-content 的元素`);
        }

        if (courseContents.length === 0) {
            courseContents = document.querySelectorAll('li');
            console.log(`📌 方法3：找到 ${courseContents.length} 个 li 元素`);
        }

        courseContents.forEach((item, index) => {
            try {
                const progressElement = item.querySelector('.cvtb-MCK-CsCt-studyProgress, .cvtb-NCK-CsCt-studyProgress');
                const titleElement = item.querySelector('.cvtb-MCK-CsCt-title, .cvtb-NCK-CsCt-title, [class*="title"]');

                if (!progressElement || !titleElement) {
                    return;
                }

                const progressText = progressElement.textContent.trim();
                const progressMatch = progressText.match(/(\d+)%/);
                const progress = progressMatch ? parseInt(progressMatch[1]) : 0;
                const title = titleElement.textContent.trim() || `课程${index + 1}`;
                const linkElement = item.querySelector('a, [onclick], .cvtb-MCK-CsCt-title, .cvtb-NCK-CsCt-title') || item;

                if (!linkElement) return;

                allCourses.push({
                    element: item,
                    title: title,
                    progress: progress,
                    link: linkElement,
                    index: allCourses.length + 1
                });
            } catch (e) {
                console.error(`❌ 解析课程 ${index + 1} 时出错:`, e);
            }
        });

        if (allCourses.length === 0) {
            console.log('⚠️ 未找到任何课程');
            return false;
        }

        console.log(`📚 共找到 ${allCourses.length} 门课程`);

        const unfinishedCourse = allCourses.find(course => course.progress < 100);

        if (!unfinishedCourse) {
            console.log('🎉 当前课程所有视频都已完成！');
            return false;
        }

        console.log(`✅ 找到未完成视频: "${unfinishedCourse.title}" (${unfinishedCourse.progress}%)`);

        unfinishedCourse.element.style.outline = '3px solid rgb(74, 222, 128)';
        unfinishedCourse.element.style.outlineOffset = '2px';
        unfinishedCourse.element.style.transition = 'all 0.3s ease';

        setTimeout(() => {
            console.log(`🚀 正在跳转到: ${unfinishedCourse.title}`);
            try {
                unfinishedCourse.link.click();
            } catch (e) {
                console.error('❌ 点击失败:', e);
            }
        }, 500);

        return true;
    }

    function autoJumpOnLoadInVideoPage() {
        if (!AUTO_JUMP) {
            console.log('⏸️ 自动跳转功能已关闭');
            return;
        }

        if (window.self !== window.top) {
            console.log('⏸️ 当前在iframe中，跳过自动跳转');
            return;
        }

        const url = window.location.href;
        if (!url.includes('study.enaea.edu.cn')) {
            console.log('⏸️ 当前不在study.enaea.edu.cn域名，跳过自动跳转');
            return;
        }

        console.log('⏳ 将在3秒、5秒、8秒后尝试自动查找未完成课程...');

        let jumpSuccess = false;

        function tryAutoFind(attemptNum) {
            if (jumpSuccess) {
                console.log(`⏭️ 第${attemptNum}次尝试取消（已成功跳转）`);
                return;
            }

            console.log(`🤖 第${attemptNum}次自动执行"查找未完成课程"功能...`);

            const courseElements = document.querySelectorAll('.cvtb-MCK-course-content, .cvtb-NCK-course-content');
            console.log(`   预检查：找到 ${courseElements.length} 个课程元素`);

            if (courseElements.length > 0) {
                console.log('✅ 找到课程列表，准备分析并跳转到未完成课程...');
            }

            const result = findAndJumpToUnfinishedCourse();

            if (result === true) {
                jumpSuccess = true;
                console.log('🎉 自动跳转成功，后续尝试已取消');
            }
        }

        setTimeout(() => {
            console.log('⏰ 第1次尝试（页面加载后3秒）');
            tryAutoFind(1);
        }, 3000);

        setTimeout(() => {
            console.log('⏰ 第2次尝试（页面加载后5秒）');
            tryAutoFind(2);
        }, 5000);

        setTimeout(() => {
            console.log('⏰ 第3次尝试（页面加载后8秒）');
            tryAutoFind(3);
        }, 8000);
    }

    // ==================== 播放页：定时检测所有视频进度 ====================

    function checkAllVideosCompleted() {
        // 只在课程播放页执行
        const url = window.location.href;
        if (!url.includes('viewerforccvideo.do') && !url.includes('viewerforicourse.do')) {
            return;
        }

        if (!AUTO_CONTINUOUS) {
            return;
        }

        // 避免频繁检测
        const now = Date.now();
        if (now - lastCheckTime < CHECK_INTERVAL * 1000 - 1000) {
            return;
        }
        lastCheckTime = now;

        console.log('═══════════════════════════════════════');
        console.log(`🔍 检测课程完成状态 (间隔${CHECK_INTERVAL}秒)`);

        const courseContents = document.querySelectorAll('.cvtb-MCK-course-content, .cvtb-NCK-course-content');

        if (courseContents.length === 0) {
            console.log('⚠️ 未找到课程列表元素');
            return;
        }

        console.log(`📊 找到 ${courseContents.length} 个课程视频`);

        let allCompleted = true;
        let completedCount = 0;
        let courseDetails = [];

        courseContents.forEach((item, index) => {
            try {
                const progressElement = item.querySelector('.cvtb-MCK-CsCt-studyProgress, .cvtb-NCK-CsCt-studyProgress');
                const titleElement = item.querySelector('.cvtb-MCK-CsCt-title, .cvtb-NCK-CsCt-title, [class*="title"]');

                if (!progressElement) return;

                const progressText = progressElement.textContent.trim();
                const progressMatch = progressText.match(/(\d+)%/);
                const progress = progressMatch ? parseInt(progressMatch[1]) : 0;
                const title = titleElement ? titleElement.textContent.trim() : `视频${index + 1}`;

                courseDetails.push({ title, progress });

                if (progress === 100) {
                    completedCount++;
                } else {
                    allCompleted = false;
                }
            } catch (e) {
                console.error(`❌ 解析视频 ${index + 1} 时出错:`, e);
            }
        });

        console.log(`📈 完成进度: ${completedCount}/${courseContents.length}`);
        courseDetails.forEach((detail, idx) => {
            const status = detail.progress === 100 ? '✅' : '⏳';
            console.log(`   ${status} ${idx + 1}. ${detail.title}: ${detail.progress}%`);
        });

        if (allCompleted && courseContents.length > 0) {
            console.log('🎉🎉🎉 当前课程所有视频已完成！');
            console.log('📨 准备发送完成信号到列表页...');

            // 发送完成信号
            const signal = {
                timestamp: Date.now(),
                courseUrl: window.location.href,
                totalVideos: courseContents.length
            };

            localStorage.setItem('enaea_course_completed_signal', JSON.stringify(signal));

            // 增加连续刷课计数
            let count = parseInt(localStorage.getItem('enaea_continuous_count') || '0');
            count++;
            localStorage.setItem('enaea_continuous_count', count.toString());

            console.log(`✅ 完成信号已发送！这是第 ${count} 门连续完成的课程`);

            // 停止检测定时器
            if (checkTimer) {
                clearInterval(checkTimer);
                checkTimer = null;
                console.log('⏸️ 已停止课程完成检测定时器');
            }
        } else {
            console.log(`⏳ 课程尚未完成，将在 ${CHECK_INTERVAL} 秒后再次检测`);
        }
    }

    function startCourseCompletionCheck() {
        const url = window.location.href;
        if (!url.includes('viewerforccvideo.do') && !url.includes('viewerforicourse.do')) {
            return;
        }

        if (!AUTO_CONTINUOUS) {
            console.log('⏸️ 自动连续刷课功能已关闭');
            return;
        }

        console.log(`🔄 启动课程完成检测 (间隔: ${CHECK_INTERVAL}秒)`);

        // 清除旧的定时器
        if (checkTimer) {
            clearInterval(checkTimer);
        }

        // 启动新的定时器
        checkTimer = setInterval(checkAllVideosCompleted, CHECK_INTERVAL * 1000);

        // 立即执行一次（延迟10秒，等页面加载）
        setTimeout(checkAllVideosCompleted, 10000);
    }

    // ==================== 列表页：自动选择未完成课程 ====================

    function findAndClickUnfinishedCourseInList() {
        console.log('═══════════════════════════════════════');
        console.log('📋 正在课程列表页面查找未完成的课程...');

        let url = '';
        try {
            url = window.location.href;
            console.log('📍 当前URL:', url);
        } catch (e) {
            console.log('⚠️ 无法获取URL');
        }

        if (!document.body) {
            console.log('⚠️ 页面body还未加载，延迟1秒后重试...');
            setTimeout(findAndClickUnfinishedCourseInList, 1000);
            return false;
        }

        const table = document.querySelector('#J_myOptionRecords');
        console.log('🔍 查找表格 #J_myOptionRecords:', table ? '找到' : '未找到');

        if (!table) {
            console.log('⚠️ 未找到课程列表表格，页面可能还在加载');
            return false;
        }

        const allRows = document.querySelectorAll('#J_myOptionRecords tbody tr');
        console.log(`📊 找到 ${allRows.length} 行数据`);

        let allCourses = [];

        allRows.forEach((row, index) => {
            try {
                const categoryTitle = row.querySelector('td[colspan="6"]');
                if (categoryTitle) {
                    console.log(`📂 分类: ${categoryTitle.textContent.trim()}`);
                    return;
                }

                const progressElement = row.querySelector('.progressvalue');
                if (!progressElement) {
                    return;
                }

                const progressText = progressElement.textContent.trim();
                const progressMatch = progressText.match(/(\d+)%/);
                const progress = progressMatch ? parseInt(progressMatch[1]) : 0;

                const titleElement = row.querySelector('.course-title');
                const title = titleElement ? titleElement.getAttribute('title') || titleElement.textContent.trim() : `课程${index}`;

                const learnButton = row.querySelector('a.golearn');

                if (!learnButton) {
                    return;
                }

                allCourses.push({
                    row: row,
                    title: title,
                    progress: progress,
                    button: learnButton,
                    index: allCourses.length + 1
                });

                console.log(`✅ 课程 ${allCourses.length}: "${title}" - 进度: ${progress}%`);
            } catch (e) {
                console.error(`❌ 解析行 ${index + 1} 时出错:`, e);
            }
        });

        if (allCourses.length === 0) {
            console.log('⚠️ 未找到任何课程');
            return false;
        }

        console.log(`\n📚 共找到 ${allCourses.length} 门课程`);

        const unfinishedCourse = allCourses.find(course => course.progress < 100);

        if (!unfinishedCourse) {
            // 当前页全部完成，检查是否有下一页
            console.log('✅ 当前页所有课程已完成');

            // 获取分页信息
            const nextBtn = document.querySelector('#J_myOptionRecords_next');
            const isNextDisabled = nextBtn && nextBtn.classList.contains('paginate_button_disabled');

            if (nextBtn && !isNextDisabled) {
                // 有下一页，获取当前页码信息
                const activePageBtn = document.querySelector('.paginate_active');
                const currentPage = activePageBtn ? activePageBtn.textContent.trim() : '?';

                console.log(`📄 当前第 ${currentPage} 页已完成，准备翻到下一页...`);

                // 点击下一页按钮
                nextBtn.click();

                console.log('⏳ 等待页面加载（2秒）...');

                // 等待页面加载后继续检测
                setTimeout(() => {
                    console.log('🔄 页面加载完成，继续检测下一页...');
                    findAndClickUnfinishedCourseInList();
                }, 2000);

                return true; // 返回true表示正在处理
            } else {
                // 没有下一页了，真的全部完成
                console.log('🎉🎉🎉 太棒了！所有页面的课程都已完成 100%！');
                console.log('🏆 学习任务全部完成！');

                // 清除连续刷课计数
                localStorage.removeItem('enaea_continuous_count');

                // 弹窗提示
                alert('🎉 恭喜！所有课程已完成！\n\n所有页面的课程已全部学习完毕。');

                return false;
            }
        }

        console.log(`\n✅ 找到未完成课程: "${unfinishedCourse.title}" (${unfinishedCourse.progress}%)`);
        console.log(`🎯 这是第 ${unfinishedCourse.index} 门课程，即将打开...`);

        unfinishedCourse.row.style.backgroundColor = 'rgba(74, 222, 128, 0.2)';
        unfinishedCourse.row.style.transition = 'all 0.3s ease';

        setTimeout(() => {
            console.log(`🚀 正在打开课程: ${unfinishedCourse.title}`);
            try {
                unfinishedCourse.button.click();
                return true;
            } catch (e) {
                console.error('❌ 点击失败:', e);
                const vurl = unfinishedCourse.button.getAttribute('data-vurl');
                if (vurl) {
                    console.log('🔄 尝试直接跳转到:', vurl);
                    window.location.href = vurl;
                    return true;
                }
            }
            return false;
        }, 1000);

        return true;
    }

    function autoSelectCourseInList() {
        if (!AUTO_SELECT_COURSE) {
            console.log('⏸️ 列表页自动选课功能已关闭');
            return;
        }

        let isInIframe = false;
        try {
            isInIframe = (window.self !== window.top);
        } catch (e) {
            isInIframe = true;
        }

        if (isInIframe) {
            console.log('⏸️ 当前在iframe中，跳过列表页自动选课');
            return;
        }

        let url = '';
        try {
            url = window.location.href;
        } catch (e) {
            console.log('⚠️ 无法获取当前URL');
            return;
        }

        console.log('🔍 列表页自动选课检测:');
        console.log('  当前URL:', url);

        if (url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do')) {
            console.log('⏸️ 当前在视频播放页面，跳过列表页自动选课');
            return;
        }

        if (!url.includes('study.enaea.edu.cn')) {
            console.log('⏸️ 当前不在study.enaea.edu.cn域名，跳过列表页自动选课');
            return;
        }

        console.log('✅ 页面检测通过，将在3秒、5秒、8秒后尝试在列表页自动选择未完成课程...');

        let selectSuccess = false;

        function tryAutoSelect(attemptNum) {
            if (selectSuccess) {
                console.log(`⏭️ 第${attemptNum}次尝试取消（已成功选择）`);
                return;
            }

            console.log(`🤖 第${attemptNum}次自动执行"列表页选课"功能...`);

            const table = document.querySelector('#J_myOptionRecords');
            if (!table) {
                console.log('⚠️ 未找到课程列表表格');
                return;
            }

            console.log('✅ 找到课程列表表格，准备分析...');

            const result = findAndClickUnfinishedCourseInList();

            if (result === true) {
                selectSuccess = true;
                console.log('🎉 列表页自动选课成功，后续尝试已取消');
            }
        }

        setTimeout(() => {
            console.log('⏰ 第1次尝试（页面加载后3秒）');
            tryAutoSelect(1);
        }, 3000);

        setTimeout(() => {
            console.log('⏰ 第2次尝试（页面加载后5秒）');
            tryAutoSelect(2);
        }, 5000);

        setTimeout(() => {
            console.log('⏰ 第3次尝试（页面加载后8秒）');
            tryAutoSelect(3);
        }, 8000);
    }

    // ==================== 列表页：监听课程完成信号 ====================

    function setupStorageListener() {
        const url = window.location.href;

        // 只在列表页监听
        if (url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do')) {
            return;
        }

        if (!AUTO_CONTINUOUS) {
            console.log('⏸️ 自动连续刷课功能已关闭，不监听完成信号');
            return;
        }

        console.log('👂 开始监听课程完成信号...');

        // 监听 storage 事件
        window.addEventListener('storage', (e) => {
            if (e.key === 'enaea_course_completed_signal') {
                console.log('═══════════════════════════════════════');
                console.log('📨 收到课程完成信号！');

                try {
                    const signal = JSON.parse(e.newValue);
                    console.log('📊 信号详情:', signal);

                    handleCourseCompleted();
                } catch (err) {
                    console.error('❌ 解析信号失败:', err);
                }
            }
        });

        // 兜底：定时检查信号（每5秒）
        setInterval(() => {
            const signal = localStorage.getItem('enaea_course_completed_signal');
            if (signal) {
                try {
                    const data = JSON.parse(signal);
                    // 检查信号是否是最近10秒内的（避免处理旧信号）
                    if (Date.now() - data.timestamp < 10000) {
                        console.log('📨 定时检查到课程完成信号');
                        handleCourseCompleted();
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }, 5000);
    }

    function handleCourseCompleted() {
        if (!AUTO_CONTINUOUS) {
            console.log('⏸️ 自动连续刷课功能已关闭');
            return;
        }

        // 检查连续刷课次数
        let count = parseInt(localStorage.getItem('enaea_continuous_count') || '0');
        console.log(`📊 当前连续刷课计数: ${count}`);

        if (count >= MAX_CONTINUOUS_COUNT) {
            console.log(`⚠️ 已连续刷课 ${count} 门课程，达到上限 ${MAX_CONTINUOUS_COUNT}`);
            alert(`已连续自动刷课 ${count} 门课程！\n\n为了安全，自动刷课已暂停。\n请检查学习进度，如需继续请手动开启。`);
            AUTO_CONTINUOUS = false;
            localStorage.setItem('enaea_auto_continuous', 'false');
            // 更新控制面板
            const checkbox = document.getElementById('auto-continuous');
            if (checkbox) checkbox.checked = false;
            return;
        }

        console.log('⏳ 等待2秒后刷新列表页...');
        console.log('💡 刷新后将自动选择下一门未完成的课程');

        // 清除完成信号（避免重复处理）
        localStorage.removeItem('enaea_course_completed_signal');

        // 延迟2秒后刷新页面
        setTimeout(() => {
            console.log('🔄 正在刷新页面...');
            location.reload();
        }, 2000);
    }

    // ==================== 自动点击继续学习 ====================

    function autoClickContinue() {
        setInterval(() => {
            const continueBtn = document.querySelector('.el-dialog__footer button.el-button--primary');
            if (continueBtn && continueBtn.textContent.includes('继续')) {
                console.log('🔄 检测到"继续学习"按钮，自动点击');
                continueBtn.click();
            }
        }, 2000);
    }

    // ==================== 监听事件 ====================

    function setupEventListeners() {
        document.addEventListener('play', function(e) {
            if (e.target.tagName === 'VIDEO') {
                setVideoSpeed(e.target);
            }
        }, true);

        document.addEventListener('loadedmetadata', function(e) {
            if (e.target.tagName === 'VIDEO') {
                setVideoSpeed(e.target);
            }
        }, true);

        // 【新增】捕获阶段监听，覆盖播放器内部换集时触发的事件，
        // 即便事件不冒泡也能捕获到。
        document.addEventListener('loadstart', function(e) {
            if (e.target.tagName === 'VIDEO') {
                setVideoSpeed(e.target);
            }
        }, true);

        document.addEventListener('canplay', function(e) {
            if (e.target.tagName === 'VIDEO') {
                setVideoSpeed(e.target);
            }
        }, true);
    }

    function checkIframes() {
        const iframes = document.querySelectorAll('iframe');
        if (iframes.length === 0) return;

        iframes.forEach((iframe, index) => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc) {
                    const videos = iframeDoc.querySelectorAll('video');
                    videos.forEach(video => setVideoSpeed(video));
                }
            } catch (e) {
                // 静默处理跨域错误
            }
        });
    }

    // ==================== 浮动控制面板 ====================

    function createPanel() {
        // 判断当前页面类型
        const url = window.location.href;
        const isVideoPage = url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do');
        const pageType = isVideoPage ? '播放页' : '列表页';

        const panel = document.createElement('div');
        panel.id = 'enaea-control-panel';

        // 根据页面类型生成不同的面板内容
        let panelContent = '';

        if (isVideoPage) {
            // ========== 播放页面板 ==========
            panelContent = `
            <div class="panel-header" id="panel-header">
                <span style="font-weight: bold; font-size: 13px;">🎓 ENAEA自动刷课助手 v1.2</span>
                <button id="panel-minimize" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0 5px;">−</button>
            </div>
            <div class="panel-content" id="panel-content">
                <div class="control-group" style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 10px;">
                    📺 当前：播放页
                </div>
                <div class="control-group">
                    <label>
                        倍速:
                        <select id="speed-select">
                            <option value="1" ${TARGET_SPEED === 1 ? 'selected' : ''}>1x</option>
                            <option value="2" ${TARGET_SPEED === 2 ? 'selected' : ''}>2x</option>
                            <option value="4" ${TARGET_SPEED === 4 ? 'selected' : ''}>4x</option>
                        </select>
                    </label>
                </div>
                <div class="control-group">
                    <label>
                        <input type="checkbox" id="auto-mute" ${AUTO_MUTE ? 'checked' : ''}>
                        自动静音
                    </label>
                </div>
                <div class="control-group">
                    <label>
                        <input type="checkbox" id="auto-jump" ${AUTO_JUMP ? 'checked' : ''}>
                        播放页自动跳转
                    </label>
                </div>
                <div class="control-group" style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 10px; margin-top: 10px;">
                    <label>
                        <input type="checkbox" id="auto-continuous" ${AUTO_CONTINUOUS ? 'checked' : ''}>
                        <strong>🔥 自动连续刷课</strong>
                    </label>
                </div>
                <div class="control-group">
                    <label>
                        检测间隔:
                        <select id="check-interval">
                            <option value="5" ${CHECK_INTERVAL === 5 ? 'selected' : ''}>5秒</option>
                            <option value="10" ${CHECK_INTERVAL === 10 ? 'selected' : ''}>10秒</option>
                            <option value="15" ${CHECK_INTERVAL === 15 ? 'selected' : ''}>15秒</option>
                            <option value="20" ${CHECK_INTERVAL === 20 ? 'selected' : ''}>20秒</option>
                            <option value="30" ${CHECK_INTERVAL === 30 ? 'selected' : ''}>30秒</option>
                        </select>
                    </label>
                </div>
                <div class="control-group" style="font-size: 11px; color: rgba(255,255,255,0.8); margin-top: -5px;">
                    下次检测: <span id="next-check-time">--</span>
                </div>
                <div class="control-group">
                    <button id="find-course-btn" style="width: 100%; padding: 8px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold;">
                        🔍 检测未完成视频
                    </button>
                </div>
                <div class="control-group">
                    <button id="pause-check-btn" style="width: 100%; padding: 6px; background: rgba(255,255,255,0.2); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        ⏸️ 暂停检测
                    </button>
                </div>
                <div class="control-group">
                    <button id="manual-check-btn" style="width: 100%; padding: 6px; background: rgba(255,255,255,0.2); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🔄 立即检测完成度
                    </button>
                </div>
                <div class="control-group" style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.2);">
                    <a href="https://github.com/chnlion/enaea-auto-study" target="_blank" style="color: rgba(255,255,255,0.9); text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 5px;">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;">
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
                        </svg>
                        <span>在 GitHub 上查看此项目</span>
                    </a>
                </div>
            </div>
            `;
        } else {
            // ========== 列表页面板 ==========
            panelContent = `
            <div class="panel-header" id="panel-header">
                <span style="font-weight: bold; font-size: 13px;">🎓 ENAEA自动刷课助手 v1.1</span>
                <button id="panel-minimize" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0 5px;">−</button>
            </div>
            <div class="panel-content" id="panel-content">
                <div class="control-group" style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 10px;">
                    📋 当前：列表页
                </div>
                <div class="control-group">
                    <label>
                        <input type="checkbox" id="auto-select" ${AUTO_SELECT_COURSE ? 'checked' : ''}>
                        列表页自动选课
                    </label>
                </div>
                <div class="control-group" style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 10px; margin-top: 10px;">
                    <label>
                        <input type="checkbox" id="auto-continuous" ${AUTO_CONTINUOUS ? 'checked' : ''}>
                        <strong>🔥 自动连续刷课</strong>
                    </label>
                </div>
                <div class="control-group">
                    <label>
                        检测间隔:
                        <select id="check-interval">
                            <option value="5" ${CHECK_INTERVAL === 5 ? 'selected' : ''}>5秒</option>
                            <option value="10" ${CHECK_INTERVAL === 10 ? 'selected' : ''}>10秒</option>
                            <option value="15" ${CHECK_INTERVAL === 15 ? 'selected' : ''}>15秒</option>
                            <option value="20" ${CHECK_INTERVAL === 20 ? 'selected' : ''}>20秒</option>
                            <option value="30" ${CHECK_INTERVAL === 30 ? 'selected' : ''}>30秒</option>
                        </select>
                    </label>
                </div>
                <div class="control-group" style="font-size: 11px; color: rgba(255,255,255,0.8); margin-top: -5px;">
                    已连续完成: <span id="continuous-count">0</span> 门 (上限: ${MAX_CONTINUOUS_COUNT})
                </div>
                <div class="control-group" style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 10px; margin-top: 10px;">
                    <label>
                        倍速设置:
                        <select id="speed-select">
                            <option value="1" ${TARGET_SPEED === 1 ? 'selected' : ''}>1x</option>
                            <option value="2" ${TARGET_SPEED === 2 ? 'selected' : ''}>2x</option>
                            <option value="4" ${TARGET_SPEED === 4 ? 'selected' : ''}>4x</option>
                        </select>
                    </label>
                </div>
                <div class="control-group">
                    <label>
                        <input type="checkbox" id="auto-mute" ${AUTO_MUTE ? 'checked' : ''}>
                        自动静音
                    </label>
                </div>
                <div class="control-group">
                    <button id="select-course-btn" style="width: 100%; padding: 8px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold;">
                        📋 立即选择课程
                    </button>
                </div>
                <div class="control-group">
                    <button id="refresh-page-btn" style="width: 100%; padding: 6px; background: rgba(255,255,255,0.2); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🔄 刷新进度
                    </button>
                </div>
                <div class="control-group">
                    <button id="clear-signal-btn" style="width: 100%; padding: 6px; background: rgba(255,255,255,0.2); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🧹 清除完成信号
                    </button>
                </div>
                <div class="control-group" style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.2);">
                    <a href="https://github.com/chnlion/enaea-auto-study" target="_blank" style="color: rgba(255,255,255,0.9); text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 5px;">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;">
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
                        </svg>
                        <span>在 GitHub 上查看此项目</span>
                    </a>
                </div>
            </div>
            `;
        }

        panel.innerHTML = panelContent;

        const style = document.createElement('style');
        style.textContent = `
            #enaea-control-panel {
                position: fixed;
                top: 20px;
                left: 20px;
                width: 240px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                z-index: 999999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                color: white;
                backdrop-filter: blur(10px);
                cursor: move;
            }
            .panel-header {
                padding: 12px 15px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 12px 12px 0 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
            }
            .panel-content {
                padding: 15px;
            }
            .control-group {
                margin-bottom: 12px;
            }
            .control-group label {
                display: flex;
                align-items: center;
                font-size: 13px;
                cursor: pointer;
            }
            .control-group input[type="checkbox"] {
                margin-right: 8px;
                cursor: pointer;
            }
            .control-group select {
                margin-left: 8px;
                padding: 4px 8px;
                border-radius: 4px;
                border: none;
                background: rgba(255, 255, 255, 0.9);
                cursor: pointer;
                flex: 1;
                font-size: 12px;
            }
            #panel-minimize:hover {
                opacity: 0.7;
            }
            .control-group button:hover {
                opacity: 0.9;
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            }
            .control-group button:active {
                transform: translateY(0);
            }
            #continuous-count {
                font-weight: bold;
                color: #4ade80;
            }
        `;

        document.documentElement.appendChild(style);
        document.body.appendChild(panel);

        // 更新连续计数显示
        function updateCountDisplay() {
            const countSpan = document.getElementById('continuous-count');
            if (countSpan) {
                const count = localStorage.getItem('enaea_continuous_count') || '0';
                countSpan.textContent = count;
            }
        }
        updateCountDisplay();
        setInterval(updateCountDisplay, 5000);

        // 拖拽功能
        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        const header = document.getElementById('panel-header');

        header.addEventListener('mousedown', (e) => {
            if (e.target.id === 'panel-minimize') return;
            initialX = e.clientX - panel.offsetLeft;
            initialY = e.clientY - panel.offsetTop;
            isDragging = true;
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                panel.style.left = currentX + 'px';
                panel.style.top = currentY + 'px';
                panel.style.right = 'auto';
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // 最小化功能
        const minimizeBtn = document.getElementById('panel-minimize');
        const content = document.getElementById('panel-content');
        let isMinimized = false;

        minimizeBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            content.style.display = isMinimized ? 'none' : 'block';
            minimizeBtn.textContent = isMinimized ? '+' : '−';
        });

        // 控件事件监听
        document.getElementById('auto-mute').addEventListener('change', (e) => {
            AUTO_MUTE = e.target.checked;
            localStorage.setItem('enaea_auto_mute', AUTO_MUTE);
            console.log(`🔇 自动静音: ${AUTO_MUTE ? '开启' : '关闭'}`);
            setAllVideos();
        });

        document.getElementById('speed-select').addEventListener('change', (e) => {
            TARGET_SPEED = parseFloat(e.target.value);
            localStorage.setItem('enaea_target_speed', TARGET_SPEED);
            console.log(`⚡ 播放速度已调整为: ${TARGET_SPEED}x`);
            setAllVideos();
        });

        document.getElementById('auto-jump').addEventListener('change', (e) => {
            AUTO_JUMP = e.target.checked;
            console.log(`🚀 播放页自动跳转: ${AUTO_JUMP ? '开启' : '关闭'}`);
        });

        document.getElementById('auto-select').addEventListener('change', (e) => {
            AUTO_SELECT_COURSE = e.target.checked;
            console.log(`📋 列表页自动选课: ${AUTO_SELECT_COURSE ? '开启' : '关闭'}`);
        });

        document.getElementById('auto-continuous').addEventListener('change', (e) => {
            AUTO_CONTINUOUS = e.target.checked;
            localStorage.setItem('enaea_auto_continuous', AUTO_CONTINUOUS);
            console.log(`🔥 自动连续刷课: ${AUTO_CONTINUOUS ? '开启' : '关闭'}`);

            if (AUTO_CONTINUOUS) {
                // 如果在课程页，启动检测
                const url = window.location.href;
                if (url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do')) {
                    startCourseCompletionCheck();
                }
            } else {
                // 停止检测
                if (checkTimer) {
                    clearInterval(checkTimer);
                    checkTimer = null;
                    console.log('⏸️ 已停止课程完成检测');
                }
            }
        });

        document.getElementById('check-interval').addEventListener('change', (e) => {
            CHECK_INTERVAL = parseInt(e.target.value);
            localStorage.setItem('enaea_check_interval', CHECK_INTERVAL);
            console.log(`⏱️ 检测间隔已调整为: ${CHECK_INTERVAL}秒`);

            // 如果正在检测，重启定时器
            const url = window.location.href;
            if ((url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do')) && AUTO_CONTINUOUS) {
                if (checkTimer) {
                    clearInterval(checkTimer);
                }
                checkTimer = setInterval(checkAllVideosCompleted, CHECK_INTERVAL * 1000);
                console.log('🔄 已重启课程完成检测定时器');
            }
        });

        // 播放页按钮事件
        const findCourseBtn = document.getElementById('find-course-btn');
        if (findCourseBtn) {
            findCourseBtn.addEventListener('click', () => {
                console.log('🔍 手动触发检测未完成视频...');
                findAndJumpToUnfinishedCourse();
            });
        }

        const pauseCheckBtn = document.getElementById('pause-check-btn');
        if (pauseCheckBtn) {
            let isPaused = false;
            pauseCheckBtn.addEventListener('click', () => {
                isPaused = !isPaused;
                if (isPaused) {
                    // 暂停检测
                    if (checkTimer) {
                        clearInterval(checkTimer);
                        checkTimer = null;
                    }
                    pauseCheckBtn.textContent = '▶️ 恢复检测';
                    pauseCheckBtn.style.background = 'rgba(74, 222, 128, 0.3)';
                    console.log('⏸️ 已暂停自动检测');
                } else {
                    // 恢复检测
                    checkTimer = setInterval(checkAllVideosCompleted, CHECK_INTERVAL * 1000);
                    pauseCheckBtn.textContent = '⏸️ 暂停检测';
                    pauseCheckBtn.style.background = 'rgba(255,255,255,0.2)';
                    console.log('▶️ 已恢复自动检测');
                }
            });
        }

        const manualCheckBtn = document.getElementById('manual-check-btn');
        if (manualCheckBtn) {
            manualCheckBtn.addEventListener('click', () => {
                console.log('🔄 手动触发立即检测完成度...');
                checkAllVideosCompleted();
            });
        }

        // 列表页按钮事件
        const selectCourseBtn = document.getElementById('select-course-btn');
        if (selectCourseBtn) {
            selectCourseBtn.addEventListener('click', () => {
                console.log('📋 手动触发列表页选课...');
                findAndClickUnfinishedCourseInList();
            });
        }

        const refreshPageBtn = document.getElementById('refresh-page-btn');
        if (refreshPageBtn) {
            refreshPageBtn.addEventListener('click', () => {
                console.log('🔄 刷新页面...');
                location.reload();
            });
        }

        const clearSignalBtn = document.getElementById('clear-signal-btn');
        if (clearSignalBtn) {
            clearSignalBtn.addEventListener('click', () => {
                localStorage.removeItem('enaea_course_completed_signal');
                localStorage.removeItem('enaea_continuous_count');
                console.log('🧹 已清除完成信号和连续计数');
                updateCountDisplay();
                alert('已清除完成信号和连续计数！');
            });
        }

        console.log('✅ 控制面板已创建');
    }

    // ==================== 初始化 ====================

    function init() {
        console.log('═══════════════════════════════════════');
        console.log('📚 ENAEA自动刷课助手 v1.1 (修复换集倍速失效)');
        console.log('✨ 自动连续刷课 + 列表页自动选课 + 播放页自动刷课');
        console.log('👤 作者: Liontooth');
        console.log('═══════════════════════════════════════');

        // 诊断信息
        console.log('🔍 环境诊断:');
        try {
            console.log('  - 当前URL:', window.location.href);
            console.log('  - 是否在iframe:', window.self !== window.top);
            console.log('  - document.readyState:', document.readyState);
            console.log('  - 自动连续刷课:', AUTO_CONTINUOUS ? '✅ 开启' : '⏸️ 关闭');
            console.log('  - 检测间隔:', CHECK_INTERVAL + '秒');
        } catch (e) {
            console.log('  - 诊断出错:', e.message);
        }

        // 视频控制初始化
        setTimeout(setAllVideos, 100);
        setTimeout(setAllVideos, 500);
        setTimeout(setAllVideos, 1000);
        setTimeout(setAllVideos, 2000);

        hijackPlaybackRate();
        startObserver();
        setInterval(setAllVideos, 2000);
        setupEventListeners();

        // 判断当前页面类型并执行相应的自动化功能
        const currentUrl = window.location.href;
        console.log('📍 检测到当前页面类型...');

        if (currentUrl.includes('viewerforccvideo.do') || currentUrl.includes('viewerforicourse.do')) {
            console.log('📺 识别为：视频播放页面');
        } else if (currentUrl.includes('study.enaea.edu.cn')) {
            console.log('📋 识别为：课程列表页面');
        }

        window.addEventListener('load', function() {
            setTimeout(setAllVideos, 500);
            setTimeout(setAllVideos, 1500);

            // 判断当前页面类型并执行相应的自动化功能
            const url = window.location.href;

            if (url.includes('viewerforccvideo.do') || url.includes('viewerforicourse.do')) {
                // 视频播放页面
                console.log('🎬 启动视频播放页功能...');
                autoJumpOnLoadInVideoPage();

                // 启动课程完成检测
                if (AUTO_CONTINUOUS) {
                    startCourseCompletionCheck();
                }
            } else if (url.includes('study.enaea.edu.cn')) {
                // 课程列表页面
                console.log('📋 启动课程列表页功能...');
                autoSelectCourseInList();

                // 监听课程完成信号
                setupStorageListener();
            }
        });

        setTimeout(checkIframes, 3000);
        setInterval(checkIframes, 5000);

        autoClickContinue();

        if (document.body) {
            createPanel();
        } else {
            setTimeout(() => {
                if (document.body) createPanel();
            }, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
