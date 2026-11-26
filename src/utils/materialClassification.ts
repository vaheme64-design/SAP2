import type { Part, PartCategory } from '../types/inventory';

export type MaterialFamily = 'SHEET_METAL' | 'FASTENER' | 'RUBBER' | 'WIP' | 'FINISHED_GOOD';

export const MATERIAL_FAMILY_LABELS_FA: Record<MaterialFamily, string> = {
  SHEET_METAL: 'ورق و کلاف فلزی',
  FASTENER: 'پیچ، مهره و اتصالات',
  RUBBER: 'لاستیک و قطعات پلیمری',
  WIP: 'قطعات نیمه‌ساخته (WIP)',
  FINISHED_GOOD: 'محصول نهایی',
};

const RUBBER_PATTERN =
  /(?:^|[\s\-_/])(rub|rubber|epdm|nbr|sbr|silicone|gasket|bushing|damper|pad|seal)(?:$|[\s\-_/])|لاستیک|پلیمر|بوش\s*لاستیکی|ضربه[\s‌]*گیر|واشر\s*لاستیکی|گسکت|اورینگ|کائوچو/i;

const FASTENER_PATTERN =
  /(?:^|[\s\-_/])(fst|fastener|nut|bolt|screw|washer|rivet|stud|pin|clip|clipper|clamp)(?:$|[\s\-_/])|پیچ|مهره|واشر|پرچ|پین|خار|بست\s*فلزی|استاد\s*بولت|اتصالات/i;

const SHEET_METAL_PATTERN =
  /(?:^|[\s\-_/])(coil|sheet|strip|blank|steel|st12|st14|st37|dc01|dc01a|dc03|dc04|spcc|spcd|spce|dx51|galv|s235|s355|qste)(?:$|[\s\-_/])|ورق|کلاف|رول|نوار\s*ورق|تسمه\s*فولادی|گالوانیزه|روغنی|سیاه/i;

export interface MaterialClassificationInput {
  category?: PartCategory | string | null;
  partCode?: string | null;
  code?: string | null;
  partName?: string | null;
  name?: string | null;
  unit?: string | null;
  materialGrade?: string | null;
  thicknessMm?: number | null;
  description?: string | null;
}

/**
 * Classifies an inventory part or stock balance into its operational material family
 * without modifying the core PartCategory schema (RAW_MATERIAL | WIP_PART | FINISHED_GOOD).
 */
export function classifyMaterialFamily(input: MaterialClassificationInput): MaterialFamily {
  const category = String(input.category || '').toUpperCase();
  if (category === 'WIP_PART') return 'WIP';
  if (category === 'FINISHED_GOOD') return 'FINISHED_GOOD';

  const haystack = [
    input.partCode || input.code || '',
    input.partName || input.name || '',
    input.materialGrade || '',
    input.description || '',
  ]
    .filter(Boolean)
    .join(' ');

  if (RUBBER_PATTERN.test(haystack)) return 'RUBBER';
  if (FASTENER_PATTERN.test(haystack)) return 'FASTENER';
  if (SHEET_METAL_PATTERN.test(haystack)) return 'SHEET_METAL';

  if (Number(input.thicknessMm || 0) > 0) return 'SHEET_METAL';
  if (String(input.unit || '').toUpperCase() === 'KG') return 'SHEET_METAL';

  return 'SHEET_METAL';
}

/**
 * Determines whether a document line represents a physical sheet-metal coil/roll
 * that should be tracked in the PhysicalCoil lifecycle register.
 * Fasteners (nuts, bolts, washers) and rubber parts are explicitly excluded even though
 * their PartCategory is RAW_MATERIAL.
 */
export function isSheetMetalCoilLine(
  part: Partial<Part> | undefined | null,
  line: {
    partCode?: string;
    partName?: string;
    unit?: string;
    materialGrade?: string;
    thicknessMm?: number;
    coilId?: string;
    coilPackNumber?: string;
    physicalCoilId?: string;
  }
): boolean {
  if (line.physicalCoilId || line.coilId || line.coilPackNumber) {
    // Explicit coil reference always belongs to coil lifecycle unless part is explicitly non-raw
    const family = classifyMaterialFamily({
      category: part?.category || 'RAW_MATERIAL',
      partCode: part?.code || line.partCode,
      partName: part?.name || line.partName,
      unit: part?.unit || line.unit,
      materialGrade: line.materialGrade || part?.materialGrade,
      thicknessMm: line.thicknessMm ?? part?.thicknessMm,
      description: part?.description,
    });
    return family === 'SHEET_METAL';
  }

  if (part && part.category !== 'RAW_MATERIAL') {
    return false;
  }

  const family = classifyMaterialFamily({
    category: part?.category || 'RAW_MATERIAL',
    partCode: part?.code || line.partCode,
    partName: part?.name || line.partName,
    unit: part?.unit || line.unit,
    materialGrade: line.materialGrade || part?.materialGrade,
    thicknessMm: line.thicknessMm ?? part?.thicknessMm,
    description: part?.description,
  });

  if (family !== 'SHEET_METAL') {
    return false;
  }

  const effectiveUnit = String(part?.unit || line.unit || '').toUpperCase();
  return effectiveUnit === 'KG' || Number(line.thicknessMm ?? part?.thicknessMm ?? 0) > 0;
}
