"""课表 .xls -> .json 转换工具
用法: python convert_xls.py "课表打印.xls"
依赖: pip install xlrd==1.2.0 (推荐) 或 Excel + PowerShell
"""
import sys, os, json

def convert_with_xlrd(path):
    import xlrd
    wb = xlrd.open_workbook(path)
    ws = wb.sheet_by_index(0)
    rows = []
    for r in range(ws.nrows):
        row = [str(ws.cell_value(r, c)).strip() for c in range(ws.ncols)]
        rows.append(row)
    return rows

def write_ps1(path):
    """生成 PowerShell 转换脚本"""
    ps1_path = os.path.splitext(path)[0] + '_convert.ps1'
    ps1 = r'''$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$wb = $excel.Workbooks.Open("{path}")
$ws = $wb.Worksheets.Item(1)
$rng = $ws.UsedRange
$data = @()
for ($r = 1; $r -le $rng.Rows.Count; $r++) {{
    $row = @()
    for ($c = 1; $c -le $rng.Columns.Count; $c++) {{
        $row += $ws.Cells.Item($r, $c).Text
    }}
    $data += ,$row
}}
$wb.Close($false)
$excel.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
$json = ConvertTo-Json -Depth 3 -Compress $data
$json | Out-File -Encoding utf8 "{out_path}"
Write-Host "Done: {out_path}"
'''.replace('{path}', path.replace('\\', '\\\\')).replace('{out_path}', os.path.splitext(path)[0] + '.json'.replace('\\', '\\\\'))
    with open(ps1_path, 'w', encoding='utf-8') as f:
        f.write(ps1)
    return ps1_path

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python convert_xls.py <schedule.xls>')
        sys.exit(1)

    xls_path = os.path.abspath(sys.argv[1])
    if not os.path.exists(xls_path):
        print(f'File not found: {xls_path}')
        sys.exit(1)

    # Try xlrd first
    try:
        rows = convert_with_xlrd(xls_path)
        print('[OK] Parsed with xlrd')
    except ImportError:
        print('xlrd not installed, generating PowerShell script...')
        ps1 = write_ps1(xls_path)
        print(f'[OK] Generated: {ps1}')
        print(f'Please run this script in PowerShell, then import the .json file.')
        print(f'Or install xlrd: pip install xlrd==1.2.0')
        sys.exit(0)
    except Exception as e:
        print(f'xlrd error: {e}')
        print('Generating PowerShell script as fallback...')
        ps1 = write_ps1(xls_path)
        print(f'[OK] Generated: {ps1}')
        sys.exit(0)

    # Save JSON
    out_path = os.path.splitext(xls_path)[0] + '.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False)
    print(f'[OK] Saved: {out_path}')
    print(f'  {len(rows)} rows, ready for import')
