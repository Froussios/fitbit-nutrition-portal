/**
 * Google Health API v4 types used by the app, transcribed from the discovery
 * document (https://health.googleapis.com/$discovery/rest?version=v4, revision 20261030).
 * Only the nutrition-related subset is modelled.
 */

export type MealType =
  | "MEAL_TYPE_UNSPECIFIED"
  | "BEFORE_BREAKFAST"
  | "BREAKFAST"
  | "BEFORE_LUNCH"
  | "LUNCH"
  | "BEFORE_DINNER"
  | "DINNER"
  | "AFTER_DINNER"
  | "SNACK"
  | "ANYTIME";

export type GoogleNutrient =
  | "BIOTIN" | "CAFFEINE" | "CALCIUM" | "CHLORIDE" | "CARBOHYDRATES" | "CHOLESTEROL" | "CHROMIUM"
  | "COPPER" | "DIETARY_FIBER" | "FOLIC_ACID" | "IODINE" | "IRON" | "MAGNESIUM" | "MANGANESE"
  | "MOLYBDENUM" | "MONOUNSATURATED_FAT" | "NIACIN" | "PANTOTHENIC_ACID" | "PHOSPHORUS"
  | "POLYUNSATURATED_FAT" | "POTASSIUM" | "PROTEIN" | "RIBOFLAVIN" | "SATURATED_FAT" | "SELENIUM"
  | "SODIUM" | "SUGAR" | "THIAMIN" | "TRANS_FAT" | "UNSATURATED_FAT" | "VITAMIN_A" | "VITAMIN_B12"
  | "VITAMIN_B6" | "VITAMIN_C" | "VITAMIN_D" | "VITAMIN_E" | "VITAMIN_K" | "ZINC" | "FOLATE";

export interface WeightQuantity {
  grams: number;
  userProvidedUnit?: string;
}

export interface EnergyQuantity {
  kcal: number;
  userProvidedUnit?: "KILOCALORIE" | "KILOJOULE" | "JOULE" | "SMALL_CALORIE" | "CALORIE";
}

export interface NutrientQuantity {
  nutrient: GoogleNutrient | string;
  quantity: WeightQuantity;
}

export interface CivilDateTime {
  date: { year: number; month: number; day: number };
  time?: { hours?: number; minutes?: number; seconds?: number; nanos?: number };
}

export interface SessionTimeInterval {
  /** RFC 3339 timestamp. */
  startTime: string;
  endTime: string;
  /** google-duration, e.g. "39600s". */
  startUtcOffset: string;
  endUtcOffset: string;
  readonly civilStartTime?: CivilDateTime;
  readonly civilEndTime?: CivilDateTime;
}

export interface Serving {
  /** Resource name of a food-measurement-unit data point. */
  foodMeasurementUnit: string;
  amount?: number;
  readonly foodMeasurementUnitDisplayName?: string;
}

export interface NutritionLog {
  interval: SessionTimeInterval;
  foodDisplayName?: string;
  /** Resource name of a Food; set only for identified logs. */
  food?: string;
  mealType?: MealType;
  energy?: EnergyQuantity;
  energyFromFat?: EnergyQuantity;
  totalFat?: WeightQuantity;
  totalCarbohydrate?: WeightQuantity;
  nutrients?: NutrientQuantity[];
  serving?: Serving;
}

export interface FoodMeasurementUnit {
  displayName: string;
  pluralDisplayName?: string;
}

export interface DataSource {
  readonly platform?: string;
  readonly application?: { packageName?: string; webClientId?: string; displayName?: string; [k: string]: unknown };
  recordingMethod?: "RECORDING_METHOD_UNSPECIFIED" | "MANUAL" | "PASSIVELY_MEASURED" | "DERIVED" | "ACTIVELY_MEASURED" | "UNKNOWN";
}

export interface DataPoint {
  /** users/{user}/dataTypes/{type}/dataPoints/{id}; the id may be client-supplied. */
  name?: string;
  dataSource?: DataSource;
  nutritionLog?: NutritionLog;
  foodMeasurementUnit?: FoodMeasurementUnit;
}

export interface ListDataPointsResponse {
  dataPoints?: DataPoint[];
  nextPageToken?: string;
}

export interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; details?: unknown[] };
  response?: DataPoint & { "@type"?: string };
}

export interface Identity {
  name: string;
  healthUserId?: string;
  legacyUserId?: string;
}
