import { supabase } from "../../storage/src/db";

export async function scoreSignals(movement: any) {
  const volumeRatio = Number(movement.volume_ratio ?? 0);
  const hourlyRatio = Number(movement.hourly_volume_ratio ?? 0);

  const capitalScore =
    0.5 * Math.min(1, volumeRatio / 2) +
    0.5 * Math.min(1, hourlyRatio / 2);

 const infoScore =
    movement.reason === "PRICE" && capitalScore < 0.4 && volumeRatio < 1.0
        ? 0.6
        : 0.2;


  const timeScore = 0.2;

  let classification = "CAPITAL";
  let confidence = capitalScore;

  if (infoScore > confidence) {
    classification = "INFO";
    confidence = infoScore;
  }

  if (timeScore > confidence) {
    classification = "TIME";
    confidence = timeScore;
  }

  const row = {
    movement_id: movement.id,
    capital_score: capitalScore,
    info_score: infoScore,
    time_score: timeScore,
    classification,
    confidence
  };

  const { error } = await supabase.from("signal_scores").insert(row);
    if (error) {
    console.error("[signals] insert failed", error.message, row);
    throw error;
    }
    console.log("[signals] inserted", row.movement_id, row.classification, row.confidence);
    console.log("[signals] inputs", {
        volumeRatio,
        hourlyRatio,
        reason: movement.reason,
        });


}
