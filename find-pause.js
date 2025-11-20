#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const FitParser =
  require("fit-file-parser").default || require("fit-file-parser");

const fitFile = process.argv[2] || "vid.fit";

if (!fs.existsSync(fitFile)) {
  console.error(`File not found: ${fitFile}`);
  process.exit(1);
}

const content = fs.readFileSync(fitFile);
const parser = new FitParser({
  force: true,
  speedUnit: "m/s",
  lengthUnit: "m",
  temperatureUnit: "celsius",
  elapsedRecordField: true,
  mode: "both", // Need 'both' mode to get records
});

parser.parse(content, (err, data) => {
  if (err) {
    console.error("Failed to parse:", err);
    process.exit(1);
  }

  // Get session data
  const session = data.activity?.sessions?.[0];
  if (session) {
    console.log("\n=== Session Summary ===");
    console.log(
      `Total elapsed time: ${session.total_elapsed_time?.toFixed(2)}s (${(
        session.total_elapsed_time / 60
      ).toFixed(2)} min)`
    );
    console.log(
      `Total timer time: ${session.total_timer_time?.toFixed(2)}s (${(
        session.total_timer_time / 60
      ).toFixed(2)} min)`
    );
    const pausedTime =
      (session.total_elapsed_time || 0) - (session.total_timer_time || 0);
    console.log(
      `Paused time: ${pausedTime.toFixed(2)}s (${(pausedTime / 60).toFixed(
        2
      )} min)`
    );
  }

  // Get records
  const records = data.records || [];
  if (records.length === 0) {
    console.log("No records found in FIT file");
    process.exit(1);
  }

  console.log(`\n=== Analyzing ${records.length} Records ===\n`);

  // Analyze timestamp gaps
  const gaps = [];
  let lastTimestamp = null;
  let lastElapsedTime = null;
  let lastTimerTime = null;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    if (!record.timestamp) continue;

    const currentTimestamp = new Date(record.timestamp).getTime();
    const elapsedTime = record.elapsed_time || 0;
    const timerTime = record.timer_time || 0;

    if (lastTimestamp !== null) {
      const timeDiff = (currentTimestamp - lastTimestamp) / 1000; // seconds
      const elapsedDiff = elapsedTime - (lastElapsedTime || 0);
      const timerDiff = timerTime - (lastTimerTime || 0);

      // Look for large gaps (more than 5 seconds)
      if (timeDiff > 5) {
        gaps.push({
          index: i,
          timestamp: record.timestamp,
          timeDiff: timeDiff,
          elapsedDiff: elapsedDiff,
          timerDiff: timerDiff,
          record: record,
        });
      }
    }

    lastTimestamp = currentTimestamp;
    lastElapsedTime = elapsedTime;
    lastTimerTime = timerTime;
  }

  // Sort gaps by size (largest first)
  gaps.sort((a, b) => b.timeDiff - a.timeDiff);

  console.log(`Found ${gaps.length} timestamp gaps > 5 seconds:\n`);

  if (gaps.length > 0) {
    // Show top 10 largest gaps
    const topGaps = gaps.slice(0, 10);
    topGaps.forEach((gap, idx) => {
      console.log(`${idx + 1}. Gap at record ${gap.index} (${gap.timestamp})`);
      console.log(
        `   Time difference: ${gap.timeDiff.toFixed(2)}s (${(
          gap.timeDiff / 60
        ).toFixed(2)} min)`
      );
      console.log(`   Elapsed time diff: ${gap.elapsedDiff.toFixed(2)}s`);
      console.log(`   Timer time diff: ${gap.timerDiff.toFixed(2)}s`);
      console.log(
        `   Gap in timer: ${(gap.timeDiff - gap.timerDiff).toFixed(
          2
        )}s (this is the pause time)`
      );
      console.log("");
    });

    // Find the largest gap (most likely the pause)
    const largestGap = gaps[0];
    console.log("=== LARGEST GAP (Most likely pause point) ===");
    console.log(`Record index: ${largestGap.index}`);
    console.log(`Timestamp: ${largestGap.timestamp}`);
    console.log(
      `Time gap: ${largestGap.timeDiff.toFixed(2)}s (${(
        largestGap.timeDiff / 60
      ).toFixed(2)} min)`
    );
    console.log(`Timer time difference: ${largestGap.timerDiff.toFixed(2)}s`);
    console.log(
      `Paused time: ${(largestGap.timeDiff - largestGap.timerDiff).toFixed(
        2
      )}s (${((largestGap.timeDiff - largestGap.timerDiff) / 60).toFixed(
        2
      )} min)`
    );

    // Find the record just before the gap
    if (largestGap.index > 0) {
      const beforeRecord = records[largestGap.index - 1];
      console.log(`\nRecord BEFORE pause:`);
      console.log(`  Timestamp: ${beforeRecord.timestamp}`);
      console.log(
        `  Elapsed time: ${beforeRecord.elapsed_time?.toFixed(2) || "N/A"}s`
      );
      console.log(
        `  Timer time: ${beforeRecord.timer_time?.toFixed(2) || "N/A"}s`
      );
    }

    console.log(`\nRecord AFTER pause:`);
    console.log(`  Timestamp: ${largestGap.record.timestamp}`);
    console.log(
      `  Elapsed time: ${largestGap.record.elapsed_time?.toFixed(2) || "N/A"}s`
    );
    console.log(
      `  Timer time: ${largestGap.record.timer_time?.toFixed(2) || "N/A"}s`
    );
  } else {
    console.log(
      "No significant gaps found. Checking elapsed_time vs timer_time differences...\n"
    );

    // Look for records where elapsed_time increases but timer_time doesn't
    let pauseStart = null;
    let pauseEnd = null;

    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];

      if (
        prev.elapsed_time !== undefined &&
        curr.elapsed_time !== undefined &&
        prev.timer_time !== undefined &&
        curr.timer_time !== undefined
      ) {
        const elapsedDiff = curr.elapsed_time - prev.elapsed_time;
        const timerDiff = curr.timer_time - prev.timer_time;

        // If elapsed time increased significantly but timer time didn't, we're in a pause
        if (elapsedDiff > 5 && timerDiff < 1) {
          if (pauseStart === null) {
            pauseStart = i - 1;
          }
          pauseEnd = i;
        }
      }
    }

    if (pauseStart !== null && pauseEnd !== null) {
      console.log(
        `Pause detected between records ${pauseStart} and ${pauseEnd}`
      );
      console.log(`Start: ${records[pauseStart].timestamp}`);
      console.log(`End: ${records[pauseEnd].timestamp}`);
    }
  }

  // Also check events if available
  if (data.events && data.events.length > 0) {
    console.log("\n=== Events ===");
    data.events.forEach((event, idx) => {
      console.log(
        `${idx + 1}. ${event.timestamp || "N/A"}: ${event.event || "N/A"} - ${
          event.event_type || "N/A"
        }`
      );
    });
  }
});
