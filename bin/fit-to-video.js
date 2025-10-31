#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const puppeteer = require("puppeteer");
const FitParser =
  require("fit-file-parser").default || require("fit-file-parser");

function printUsageAndExit() {
  console.error(
    "Usage: fit-to-video <path-to-file.fit> [--out output.mp4] [--fps 2] [--dev-mode] [--save-html]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    fps: 2, // Default to 2fps - sufficient for slow progress bar animation
    devMode: false,
    saveHtml: false,
  };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!args.input && !token.startsWith("--")) {
      args.input = token;
      continue;
    }
    if (token === "--out") {
      if (i + 1 >= tokens.length) printUsageAndExit();
      args.out = tokens[++i];
      continue;
    }
    if (token === "--fps") {
      if (i + 1 >= tokens.length) printUsageAndExit();
      args.fps = parseInt(tokens[++i], 10);
      continue;
    }
    if (token === "--dev-mode") {
      args.devMode = true;
      continue;
    }
    if (token === "--save-html") {
      args.saveHtml = true;
      continue;
    }
    printUsageAndExit();
  }
  if (!args.input) printUsageAndExit();
  return args;
}

function calculateDuration(data) {
  // Try to get duration from sessions first
  if (
    data.activity &&
    data.activity.sessions &&
    data.activity.sessions.length > 0
  ) {
    const session = data.activity.sessions[0];
    if (session.total_timer_time) {
      return session.total_timer_time; // Already in seconds
    }
    if (session.total_elapsed_time) {
      return session.total_elapsed_time; // Already in seconds
    }
  }

  // Fallback: calculate from records
  if (
    data.activity &&
    data.activity.sessions &&
    data.activity.sessions.length > 0 &&
    data.activity.sessions[0].records &&
    data.activity.sessions[0].records.length > 0
  ) {
    const records = data.activity.sessions[0].records;
    const firstRecord = records[0];
    const lastRecord = records[records.length - 1];

    if (firstRecord.timestamp && lastRecord.timestamp) {
      const start = new Date(firstRecord.timestamp);
      const end = new Date(lastRecord.timestamp);
      return (end - start) / 1000; // Convert to seconds
    }

    // Use elapsed_time as fallback
    if (lastRecord.elapsed_time) {
      return lastRecord.elapsed_time;
    }
  }

  throw new Error("Could not determine video duration from fit file");
}

function parsePace(paceStr) {
  // Parse pace in format "7:30" or "7:30 min/mile" to minutes
  const match = paceStr.match(/(\d+):(\d+)/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return minutes + seconds / 60;
  }
  // Try to parse as decimal minutes
  const decimal = parseFloat(paceStr);
  if (!isNaN(decimal)) {
    return decimal;
  }
  return null;
}

function formatPace(minutes) {
  const mins = Math.floor(minutes);
  const secs = Math.round((minutes - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptForTargetPaces(laps) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== Workout Steps ===");
  console.log(`Found ${laps.length} laps in the FIT file.\n`);

  // First pass: Identify segment types and combine consecutive warmup/cooldown laps
  const segmentGroups = [];
  let currentTime = 0;
  let intervalNumber = 1;

  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const lapDuration = lap.total_timer_time || lap.total_elapsed_time || 0;

    // Skip very short laps (likely markers or errors)
    if (lapDuration < 5) {
      console.log(
        `Skipping lap ${i + 1} (too short: ${(lapDuration / 60).toFixed(
          1
        )} min)`
      );
      continue;
    }

    const intensity = lap.intensity || "unknown";

    // Determine segment type
    let segmentType = "workout";
    let segmentName = "";

    if (i === 0 || intensity === "warmup") {
      segmentType = "warmup";
      segmentName = "Warm Up";
    } else if (i === laps.length - 1 || intensity === "cooldown") {
      segmentType = "cooldown";
      segmentName = "Cool Down";
    } else if (intensity === "interval") {
      segmentType = "interval";
      segmentName = `Interval ${intervalNumber}`;
      intervalNumber++;
    } else if (intensity === "recovery" || intensity === "rest") {
      segmentType = "rest";
      segmentName = "Rest";
    } else {
      segmentType = "workout";
      segmentName = `Segment ${i + 1}`;
    }

    // Check if we should combine with previous segment
    const lastGroup = segmentGroups[segmentGroups.length - 1];
    const shouldCombine =
      lastGroup &&
      lastGroup.name === segmentName &&
      (segmentType === "warmup" || segmentType === "cooldown");

    if (shouldCombine) {
      // Combine with previous segment
      lastGroup.duration += lapDuration;
      lastGroup.lapIndices.push(i);
    } else {
      // Create new segment group
      segmentGroups.push({
        type: segmentType,
        name: segmentName,
        startTime: currentTime,
        duration: lapDuration,
        lapIndices: [i],
      });
    }

    currentTime += lapDuration;
  }

  // Second pass: Prompt for target paces for each segment (combined or individual)
  const segments = [];
  let segmentStartTime = 0;

  for (const group of segmentGroups) {
    const durationMinutes = group.duration / 60;
    const lapNumbers = group.lapIndices.map((idx) => idx + 1).join(", ");

    console.log(`\n${group.name}`);
    if (group.lapIndices.length > 1) {
      console.log(`  Combined laps: ${lapNumbers}`);
    } else {
      console.log(`  Lap ${lapNumbers}`);
    }
    console.log(`  Duration: ${durationMinutes.toFixed(1)} minutes`);

    // Prompt for target pace
    let targetPaceMinutes = null;
    while (targetPaceMinutes === null) {
      const answer = await askQuestion(
        rl,
        `  What is the target pace for this segment? (format: 7:30 or 7.5 min/mile, or 'skip'): `
      );

      if (answer.toLowerCase() === "skip" || answer === "") {
        console.log("  No target pace set for this segment");
        break;
      }

      targetPaceMinutes = parsePace(answer);
      if (targetPaceMinutes === null) {
        console.log("  Invalid format. Please use format like '7:30' or '7.5'");
      } else {
        console.log(
          `  Set target pace: ${formatPace(targetPaceMinutes)} min/mile`
        );
      }
    }

    segments.push({
      type: group.type,
      name: group.name,
      startTime: segmentStartTime,
      duration: group.duration,
      endTime: segmentStartTime + group.duration,
      targetPace: targetPaceMinutes,
    });

    segmentStartTime += group.duration;
  }

  // Show summary
  console.log("\n=== Summary ===");
  segments.forEach((seg, i) => {
    console.log(
      `${i + 1}. ${seg.name}: ${(seg.duration / 60).toFixed(1)} min${
        seg.targetPace ? ` @ ${formatPace(seg.targetPace)} pace` : ""
      }`
    );
  });

  // Ask for confirmation of data
  const confirm = await askQuestion(rl, "\nDoes this look correct? (y/n): ");

  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
    console.log("Cancelled.");
    rl.close();
    return null;
  }

  // Ask if they want to create the video
  const createVideo = await askQuestion(
    rl,
    "\nDo you want to create the video? (y/n): "
  );
  rl.close();

  if (
    createVideo.toLowerCase() !== "y" &&
    createVideo.toLowerCase() !== "yes"
  ) {
    console.log(
      "\nVideo creation skipped. Data was gathered but no video will be created."
    );
    return { segments, createVideo: false };
  }

  return { segments, createVideo: true };
}

function extractSegments(data) {
  // Extract lap data and categorize into workout segments
  const session = data.activity?.sessions?.[0];
  if (!session || !session.laps || session.laps.length === 0) {
    return [];
  }

  const laps = session.laps;
  const segments = [];
  let currentTime = 0;

  // Categorize laps into segments (warm-up, intervals, cool-down)
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const lapDuration = lap.total_timer_time || lap.total_elapsed_time || 0;

    // Skip very short laps (likely markers or errors)
    if (lapDuration < 5) continue;

    let segmentType = "workout";
    let segmentName = "";

    // Determine segment type based on position and characteristics
    if (segments.length === 0) {
      // First significant segment is warm-up
      segmentType = "warmup";
      segmentName = "Warm Up";
    } else if (i === laps.length - 1) {
      // Last significant segment is cool-down
      segmentType = "cooldown";
      segmentName = "Cool Down";
    } else {
      // Check if this looks like an interval (around 6 minutes) or rest (around 2 minutes)
      const minutes = lapDuration / 60;
      if (minutes >= 5.5 && minutes <= 6.5) {
        segmentType = "interval";
        segmentName = `Interval ${Math.floor((i + 1) / 2)}`;
      } else if (minutes >= 1.5 && minutes <= 2.5) {
        segmentType = "rest";
        segmentName = "Rest";
      }
    }

    segments.push({
      type: segmentType,
      name: segmentName,
      startTime: currentTime,
      duration: lapDuration,
      endTime: currentTime + lapDuration,
    });

    currentTime += lapDuration;
  }

  return segments;
}

function generateHTMLTemplate(
  segments,
  totalDurationForSizing,
  width,
  height,
  videoDuration
) {
  // Calculate segment positions and widths
  const barHeight = 120;
  const barY = 40;
  const segmentMargin = 20;
  const totalMarginWidth = segmentMargin * (segments.length - 1);
  const availableWidth = width - 200;
  const usableWidth = availableWidth - totalMarginWidth;
  const totalDuration = totalDurationForSizing || videoDuration;

  // Background bar extends from top to below bars by same distance as top margin
  // Top margin is barY (40px), bars are at barY with height barHeight (120px)
  // So bars end at barY + barHeight (160px), extend another barY (40px) below = 200px total
  const backgroundBarHeight = barY + barHeight + barY; // 40 + 120 + 40 = 200px

  // Generate segment styles and HTML
  let segmentHTML = "";
  let currentX = 100;

  segments.forEach((segment, index) => {
    const actualBarWidth = (segment.duration / totalDuration) * usableWidth;
    const segmentStart = segment.startTime;
    const segmentDuration = segment.duration;

    let color = "#666666"; // Default gray
    switch (segment.type) {
      case "warmup":
        color = "#4A90E2"; // Blue
        break;
      case "interval":
        color = "#FF6B6B"; // Red
        break;
      case "rest":
        color = "#FFD93D"; // Yellow
        break;
      case "cooldown":
        color = "#6BCF7F"; // Green
        break;
    }

    // Format pace
    let paceText = "";
    if (segment.targetPace !== null && segment.targetPace !== undefined) {
      const mins = Math.floor(segment.targetPace);
      const secs = Math.round((segment.targetPace - mins) * 60);
      paceText = `${mins}:${secs.toString().padStart(2, "0")}`;
    }

    // Calculate animation timing
    const animationStart = segmentStart;
    const animationEnd = segmentStart + segmentDuration;

    segmentHTML += `
    <div class="segment" style="left: ${currentX}px; width: ${actualBarWidth}px;">
      <div class="segment-border" style="border-color: ${color};"></div>
      <div class="segment-fill" style="background-color: ${color};" data-start="${animationStart}" data-duration="${segmentDuration}"></div>
      ${paceText ? `<div class="segment-pace">${paceText}</div>` : ""}
    </div>`;

    currentX += actualBarWidth + segmentMargin;
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workout Progress</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      width: ${width}px;
      height: ${height}px;
      background-color: #00FF00; /* Green screen */
      position: relative;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }

    .background-bar {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: ${backgroundBarHeight}px;
      background-color: rgba(128, 128, 128, 0.65); /* 65% transparent grey */
      z-index: 0;
    }

    .segment {
      position: absolute;
      top: ${barY}px;
      height: ${barHeight}px;
      z-index: 1;
    }

    .segment-border {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: 4px solid;
      border-radius: 0;
    }

    .segment-fill {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 0%;
      opacity: 0.8;
      transition: none;
    }

    .segment-pace {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 48px;
      font-weight: bold;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      z-index: 10;
    }

    /* Animation for fill based on current time */
    @keyframes fillProgress {
      from {
        width: 0%;
      }
      to {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="background-bar"></div>
  ${segmentHTML}

  <script>
    // Animation control
    const segments = document.querySelectorAll('.segment-fill');
    let currentTime = 0;
    const totalDuration = ${videoDuration};

    function updateFrame(time) {
      currentTime = time;
      segments.forEach(fill => {
        const start = parseFloat(fill.dataset.start);
        const duration = parseFloat(fill.dataset.duration);
        const end = start + duration;

        if (time < start) {
          fill.style.width = '0%';
        } else if (time >= end) {
          fill.style.width = '100%';
        } else {
          const progress = ((time - start) / duration) * 100;
          fill.style.width = progress + '%';
        }
      });

      // Store current time for frame capture
      window.__currentTime = time;
    }

    // Expose updateFrame function globally
    window.updateFrame = updateFrame;
    window.totalDuration = totalDuration;
  </script>
</body>
</html>`;

  return html;
}

async function captureFrames(
  htmlPath,
  outputFramesDir,
  duration,
  fps,
  width,
  height
) {
  console.log("Launching browser for frame capture...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${htmlPath}`);

    // Wait for page to load
    await page.waitForSelector(".segment", { timeout: 5000 });

    const totalFrames = Math.ceil(duration * fps);
    const frameTime = 1 / fps;

    console.log(`Capturing ${totalFrames} frames at ${fps}fps...`);

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const currentTime = frameIndex * frameTime;

      // Update animation to current time
      await page.evaluate((time) => {
        if (window.updateFrame) {
          window.updateFrame(time);
        }
      }, currentTime);

      // Capture frame immediately - no wait needed for headless browser
      const framePath = path.join(
        outputFramesDir,
        `frame_${String(frameIndex).padStart(6, "0")}.png`
      );
      await page.screenshot({
        path: framePath,
        clip: { x: 0, y: 0, width, height },
      });

      // Report progress more frequently for long videos
      const reportInterval = totalFrames > 1000 ? 100 : 30;
      if (
        (frameIndex + 1) % reportInterval === 0 ||
        frameIndex === totalFrames - 1
      ) {
        const percent = (((frameIndex + 1) / totalFrames) * 100).toFixed(1);
        console.log(
          `  Captured ${frameIndex + 1}/${totalFrames} frames (${percent}%)...`
        );
      }
    }

    console.log("Frame capture complete!");
  } finally {
    await browser.close();
  }
}

function createProgressBarFilter(
  segments,
  totalDurationForSizing,
  width,
  height,
  videoDuration,
  tempDir
) {
  // totalDurationForSizing: used for calculating proportional segment widths
  // videoDuration: used for progress indicator movement (may be limited in dev mode)
  const totalDuration = totalDurationForSizing || videoDuration;
  const progressDuration = videoDuration || totalDuration;
  // Create separate bars for each segment, arranged side-by-side with margins
  // Each bar is proportional to its duration
  const barHeight = 120;
  const barY = 40;
  const segmentMargin = 20; // Margin between segments
  const totalMarginWidth = segmentMargin * (segments.length - 1);
  const availableWidth = width - 200; // Leave margins on sides
  const usableWidth = availableWidth - totalMarginWidth;

  const filters = [];
  const textFiles = []; // Track temp files to clean up later

  // Draw each segment as its own bar, proportional to duration
  let currentX = 100; // Starting X position

  segments.forEach((segment, index) => {
    // Calculate proportional width based on duration
    const actualBarWidth = (segment.duration / totalDuration) * usableWidth;

    let color = "0x666666"; // Default gray

    switch (segment.type) {
      case "warmup":
        color = "0x4A90E2"; // Blue
        break;
      case "interval":
        color = "0xFF6B6B"; // Red
        break;
      case "rest":
        color = "0xFFD93D"; // Yellow
        break;
      case "cooldown":
        color = "0x6BCF7F"; // Green
        break;
    }

    // Draw border only (no background fill)
    // Border thickness: 4 pixels
    const borderThickness = 4;
    filters.push(
      `drawbox=x=${currentX}:y=${barY}:w=${actualBarWidth}:h=${barHeight}:color=${color}:t=${borderThickness}`
    );

    // Progress fill for this segment (animates as time progresses)
    // Calculate if we're in this segment's time range
    const segmentStart = segment.startTime;
    const segmentEnd = segment.endTime;

    // Fill that portion of the bar up to current progress within segment
    // This creates the animated fill effect that grows from left to right
    // The fill width increases from 0 to actualBarWidth as time progresses through the segment
    const progressFillExpr = `if(between(t,${segmentStart},${segmentEnd}), ((t-${segmentStart})/${segment.duration})*${actualBarWidth}, if(gt(t,${segmentEnd}), ${actualBarWidth}, 0))`;

    // Draw filled portion up to current time within this segment
    filters.push(
      `drawbox=x=${currentX}:y=${barY}:w='${progressFillExpr}':h=${barHeight}:color=${color}@0.8:t=fill`
    );

    // Draw target pace only (centered in segment)
    const labelX = currentX + actualBarWidth / 2;
    const labelY = barY + barHeight / 2;

    // Draw target pace if available
    if (segment.targetPace !== null && segment.targetPace !== undefined) {
      const mins = Math.floor(segment.targetPace);
      const secs = Math.round((segment.targetPace - mins) * 60);
      // Use colon format - create a text file to avoid FFmpeg colon parsing issues
      const paceStr = `${mins}:${secs.toString().padStart(2, "0")}`;
      // Create temporary text file for this pace value
      const textFilePath = path.join(tempDir, `pace_${index}.txt`);
      fs.writeFileSync(textFilePath, paceStr, "utf8");
      textFiles.push(textFilePath);
      // Use textfile parameter to load text from file (avoids colon parsing issues)
      const escapedPath = textFilePath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");
      filters.push(
        `drawtext=textfile='${escapedPath}':fontcolor=white:fontsize=48:x=${labelX}:y=${labelY}:box=1:boxcolor=0x000000@0.5:boxborderw=5:fix_bounds=1`
      );
    }

    // Move to next segment position (use actual proportional width + margin)
    currentX += actualBarWidth + segmentMargin;
  });

  // Return both filter string and text files for cleanup
  return {
    filter: filters.join(","),
    textFiles: textFiles,
  };
}

async function createGreenMp4(
  outputPath,
  duration,
  fps,
  segments,
  totalDurationForSizing,
  saveHtml,
  callback
) {
  // Create a solid green 4K background video with progress bar overlay
  const width = 3840;
  const height = 2160;

  console.log(
    `Creating video with progress bar: ${duration}s at ${fps}fps -> ${outputPath}`
  );
  if (segments.length > 0) {
    console.log(`Found ${segments.length} workout segments`);
    segments.forEach((seg, i) => {
      console.log(
        `  ${i + 1}. ${seg.name || seg.type}: ${seg.duration.toFixed(1)}s (${(
          seg.duration / 60
        ).toFixed(1)} min)`
      );
    });
  }

  try {
    // Create temporary directories
    const tempDir = path.join(path.dirname(outputPath), `.temp_${Date.now()}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const framesDir = path.join(tempDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });

    // Generate HTML template
    console.log("Generating HTML template...");
    const htmlContent = generateHTMLTemplate(
      segments,
      totalDurationForSizing || duration,
      width,
      height,
      duration
    );

    const htmlPath = path.join(tempDir, "template.html");
    fs.writeFileSync(htmlPath, htmlContent, "utf8");

    // Save HTML template next to output file if requested
    if (saveHtml) {
      const savedHtmlPath = outputPath.replace(/\.mp4$/, ".html");
      fs.writeFileSync(savedHtmlPath, htmlContent, "utf8");
      console.log(`HTML template saved to: ${savedHtmlPath}`);
    }

    // Capture frames using Puppeteer
    await captureFrames(htmlPath, framesDir, duration, fps, width, height);

    // Combine frames into video using FFmpeg
    console.log("Combining frames into video...");
    const framePattern = path.join(framesDir, "frame_%06d.png");

    const ffmpegArgs = [
      "-framerate",
      String(fps),
      "-i",
      framePattern,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      // Clean up temporary files
      try {
        if (fs.existsSync(framesDir)) {
          const files = fs.readdirSync(framesDir);
          files.forEach((file) => {
            try {
              fs.unlinkSync(path.join(framesDir, file));
            } catch (err) {
              // Ignore cleanup errors
            }
          });
          fs.rmdirSync(framesDir);
        }
        if (fs.existsSync(htmlPath)) {
          fs.unlinkSync(htmlPath);
        }
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          if (files.length === 0) {
            fs.rmdirSync(tempDir);
          }
        }
      } catch (err) {
        // Ignore cleanup errors
      }

      if (code !== 0) {
        console.error("FFmpeg error output:", stderr);
        callback(new Error(`FFmpeg process exited with code ${code}`));
        return;
      }
      console.log(`Successfully created video: ${outputPath}`);
      callback(null);
    });

    ffmpeg.on("error", (err) => {
      if (err.code === "ENOENT") {
        callback(
          new Error(
            "FFmpeg not found. Please install ffmpeg: brew install ffmpeg (macOS) or visit https://ffmpeg.org/download.html"
          )
        );
      } else {
        callback(err);
      }
    });
  } catch (err) {
    callback(err);
  }
}

function displayDryRunData(data, duration, segments) {
  console.log("\n" + "=".repeat(60));
  console.log("DRY RUN - All Gathered Data");
  console.log("=".repeat(60));

  console.log("\n=== FIT File Data ===");
  console.log(
    `Duration: ${duration.toFixed(2)} seconds (${(duration / 60).toFixed(
      2
    )} minutes)`
  );

  const session = data.activity?.sessions?.[0];
  if (session) {
    console.log(
      `Total distance: ${(session.total_distance || 0).toFixed(2)} m`
    );
    console.log(`Sport: ${session.sport || "unknown"}`);
    console.log(`Number of laps: ${session.laps?.length || 0}`);
  }

  console.log("\n=== Workout Segments ===");
  console.log(`Total segments: ${segments.length}\n`);

  segments.forEach((seg, i) => {
    console.log(`Segment ${i + 1}: ${seg.name}`);
    console.log(`  Type: ${seg.type}`);
    console.log(
      `  Duration: ${seg.duration.toFixed(1)}s (${(seg.duration / 60).toFixed(
        1
      )} min)`
    );
    console.log(`  Start time: ${seg.startTime.toFixed(1)}s`);
    console.log(`  End time: ${seg.endTime.toFixed(1)}s`);
    if (seg.targetPace !== null && seg.targetPace !== undefined) {
      console.log(`  Target pace: ${formatPace(seg.targetPace)} min/mile`);
    } else {
      console.log(`  Target pace: Not set`);
    }
    console.log("");
  });

  // Calculate totals
  const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);
  console.log(
    `Total segment duration: ${totalDuration.toFixed(1)}s (${(
      totalDuration / 60
    ).toFixed(2)} min)`
  );

  // Summary by type
  const byType = {};
  segments.forEach((seg) => {
    if (!byType[seg.type]) {
      byType[seg.type] = { count: 0, duration: 0 };
    }
    byType[seg.type].count++;
    byType[seg.type].duration += seg.duration;
  });

  console.log("\n=== Summary by Type ===");
  Object.keys(byType).forEach((type) => {
    const stats = byType[type];
    console.log(
      `${type}: ${stats.count} segment(s), ${(stats.duration / 60).toFixed(
        1
      )} min total`
    );
  });

  console.log("\n" + "=".repeat(60));
  console.log("Dry run complete - no video was created");
  console.log("=".repeat(60));
}

async function main() {
  const { input, out, fps, devMode, saveHtml } = parseArgs(process.argv);
  const resolvedPath = path.resolve(process.cwd(), input);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(2);
  }

  const outputPath = out
    ? path.resolve(process.cwd(), out)
    : path.resolve(
        process.cwd(),
        path.basename(input, ".fit") + "_overlay.mp4"
      );

  if (devMode) {
    console.log("=== DEV MODE: Video will be limited to 1 minute ===");
  }

  console.log(`Parsing fit file: ${resolvedPath}`);
  const content = fs.readFileSync(resolvedPath);
  const fitParser = new FitParser({
    force: true,
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "cascade",
  });

  fitParser.parse(content, async function (error, data) {
    if (error) {
      console.error("Failed to parse .fit file:", error.message || error);
      process.exit(3);
    }

    try {
      let duration = calculateDuration(data);
      const originalDuration = duration; // Store original for proportional calculations
      console.log(`Calculated duration: ${duration.toFixed(2)} seconds`);

      // Limit duration to 1 minute in dev mode
      if (devMode) {
        const devDuration = 60; // 1 minute
        if (duration > devDuration) {
          console.log(
            `Dev mode: Limiting video duration to ${devDuration}s (${(
              devDuration / 60
            ).toFixed(1)} min) instead of ${duration.toFixed(2)}s`
          );
          duration = devDuration;
        }
      }

      // Get laps from FIT file
      const session = data.activity?.sessions?.[0];
      if (!session || !session.laps || session.laps.length === 0) {
        console.error("No laps found in FIT file");
        process.exit(6);
      }

      // Prompt user for target paces and ask if they want to create video
      const result = await promptForTargetPaces(session.laps);

      if (!result) {
        console.log("User cancelled.");
        process.exit(0);
      }

      const { segments, createVideo } = result;

      // If they don't want to create video, show detailed data and exit
      if (!createVideo) {
        displayDryRunData(data, duration, segments);
        process.exit(0);
      }

      // Otherwise, create the video (pass original duration for proportional sizing)
      createGreenMp4(
        outputPath,
        duration,
        fps,
        segments,
        originalDuration,
        saveHtml,
        (err) => {
          if (err) {
            console.error("Failed to create video:", err.message);
            process.exit(4);
          }
          console.log("Done!");
        }
      );
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(5);
    }
  });
}

main();
