import json
from pathlib import Path

refined_path = Path('src/data/ux_issue_library_ecommerce_v3.2_REFINED.json')
target_path = Path('src/data/ux_issue_library_ecommerce_v3.json')

if not refined_path.exists():
    print('ERROR: refined file not found:', refined_path)
    raise SystemExit(1)

with refined_path.open('r', encoding='utf-8') as f:
    data = json.load(f)

issues = data.get('issues', [])
print(f'Loaded refined file: {refined_path}  issues={len(issues)}')

count_negative = sum(1 for i in issues if i.get('negative_signals'))
count_verify = sum(1 for i in issues if i.get('flag_as_needs_verification'))
count_evidence_required = sum(1 for i in issues if i.get('evidence_required'))

conf_values = [i.get('confidence_weight') for i in issues if 'confidence_weight' in i]
avg_conf = sum(conf_values)/len(conf_values) if conf_values else None

print('Summary:')
print(' - issues total:', len(issues))
print(' - have negative_signals:', count_negative)
print(' - flagged needs manual verification:', count_verify)
print(' - evidence_required present:', count_evidence_required)
print(' - confidence_weight sample count:', len(conf_values))
print(' - average confidence (where present):', avg_conf)

# list IDs with low confidence (<0.6)
low_conf_ids = [i.get('issue_id') for i in issues if i.get('confidence_weight') is not None and i.get('confidence_weight') < 0.6]
print(' - issues with confidence < 0.6:', len(low_conf_ids))
if low_conf_ids:
    print('   ', ', '.join(low_conf_ids[:10]))

# Basic structure validation: ensure each issue has issue_id and signals_to_detect
missing_ids = [idx for idx,i in enumerate(issues) if 'issue_id' not in i]
missing_signals = [i.get('issue_id','<no-id>') for i in issues if 'signals_to_detect' not in i or not isinstance(i.get('signals_to_detect'), list)]
if missing_ids or missing_signals:
    print('ERROR: structural issues found:')
    if missing_ids:
        print(' - issues missing issue_id at indices:', missing_ids[:10])
    if missing_signals:
        print(' - issues missing signals_to_detect or not a list:', missing_signals[:10])
    raise SystemExit(2)

# If we reach here, consider refined file OK. Overwrite target.
try:
    with target_path.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f'Wrote refined content to {target_path}')
except Exception as e:
    print('ERROR writing target file:', e)
    raise

# Validate the written JSON using json.load
try:
    with target_path.open('r', encoding='utf-8') as f:
        json.load(f)
    print('Validated written JSON: OK')
except Exception as e:
    print('ERROR validating written JSON:', e)
    raise

print('\nDone - refined library analysis and replacement completed.')
