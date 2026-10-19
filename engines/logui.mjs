import { extractStrings } from "./static-lift.mjs";
import { stampSource } from "./stamp.mjs";

const LIBS = [
  { name: "Rayfield", re: /Rayfield/i, load: "https://sirius.menu/rayfield" },
  { name: "Fluent", re: /Fluent/i, load: "https://github.com/dawid-scripts/Fluent/releases/latest/download/main.lua" },
  { name: "Orion", re: /OrionLib|Orion/i, load: "https://raw.githubusercontent.com/shlexware/Orion/main/source" },
  { name: "Linoria", re: /Linoria|Library\.New/i, load: null },
  { name: "WindUI", re: /WindUI/i, load: null },
  { name: "MacLib", re: /MacLib/i, load: null },
  { name: "Venyx", re: /Venyx/i, load: null },
  { name: "Kavo", re: /Kavo/i, load: "https://raw.githubusercontent.com/xHeptc/Kavo-UI-Library/main/source.lua" },
];

const TAB_WORDS =
  /\b(Combat|Visuals|Misc|Main|Settings|Player|Players|Teleports|Credits|Farm|Blatant|Rage|Legit|World|Local|Server|Aimbot|ESP|Silent|Ragebot|Anti Aim|Inventory|Shop|Auto Farm|Automation|Clientside|Server|Fun|Exploits|Character|Target|Configs?)\b/g;

const FLAG_RE =
  /\b(Aimbot|ESP|Speed|Fly|Noclip|Kill Aura|Auto.?Farm|Auto.?Collect|Infinite Jump|Godmode|Hitbox|WalkSpeed|JumpPower|Silent Aim|Triggerbot|BunnyHop|Xray|Spinbot|Speed Hack|Infinite Yield|Auto Parry|Auto Block|Kill All|Team Check|Wallbang|FOV|Smoothness|Prediction)\b/gi;

const ASSET_RE = /rbxassetid:\/\/(\d{5,16})/gi;
const COLOR_RE = /Color3\.(?:fromRGB|new)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;

function luaString(s) {
  return JSON.stringify(String(s ?? ""));
}

function unique(arr, cap = 40) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const k = String(v || "").trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= cap) break;
  }
  return out;
}

function isNoiseName(s) {
  if (!s) return true;
  if (s.length < 2 || s.length > 48) return true;
  if (/https?:|window\.|document\.|function |local |User-Agent|Content-|DOCTYPE|luarmor\.net/i.test(s)) return true;
  if (/^[\\x0-9]+$/.test(s)) return true;
  return false;
}

function pullNamedCalls(source) {
  const out = [];
  const re =
    /:(CreateWindow|MakeWindow|CreateTab|AddTab|MakeTab|AddToggle|CreateToggle|AddButton|CreateButton|AddSlider|CreateSlider|AddDropdown|CreateDropdown|AddInput|CreateInput|AddParagraph|AddKeybind|AddColorpicker|AddLabel|AddSection)\s*\(\s*(?:\{[^}]{0,500}?Name\s*=\s*(["'])((?:\\.|[^\\])*?)\2|["']([^"']+)["'])/gi;
  let m;
  while ((m = re.exec(source))) {
    out.push({ kind: m[1], name: m[3] || m[4] });
  }
  const inst = /Instance\.new\s*\(\s*["'](ScreenGui|TextButton|TextLabel|TextBox|Frame|ScrollingFrame|ImageButton|ImageLabel)["']\s*\)/gi;
  while ((m = inst.exec(source))) {
    out.push({ kind: m[1], name: m[1] });
  }
  const namedInst = /Name\s*=\s*["']([^"'\n]{2,48})["']/g;
  while ((m = namedInst.exec(source))) {
    if (!isNoiseName(m[1])) out.push({ kind: "Name", name: m[1] });
  }
  const text = /(?:Title|Text)\s*=\s*["']([^"'\n]{2,48})["']/g;
  while ((m = text.exec(source))) {
    if (!isNoiseName(m[1])) out.push({ kind: "label", name: m[1] });
  }
  return out;
}

function pullAssets(source) {
  const ids = [];
  const re = /rbxassetid:\/\/(\d{5,16})/gi;
  let m;
  while ((m = re.exec(source))) ids.push(m[1]);
  const alt = /["']rbxassetid:\/\/(\d{5,16})["']/gi;
  while ((m = alt.exec(source))) ids.push(m[1]);
  return unique(ids, 24);
}

function pullColors(source) {
  const out = [];
  const re = /Color3\.(?:fromRGB|new)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    if (out.length >= 8) break;
  }
  return out;
}

export function logUi(source) {
  const raw = String(source ?? "");
  const strings = extractStrings(raw, { max: 8000 });
  const blob = strings.join("\n") + "\n" + raw.slice(0, 120000);
  const lib = LIBS.find((l) => l.re.test(blob)) || { name: "ScreenGui", load: null };
  const named = pullNamedCalls(raw);
  const assets = pullAssets(blob);
  const colors = pullColors(raw);

  const titles = [];
  const tabs = [];
  const controls = [];
  const flags = new Set();

  for (const c of named) {
    if (isNoiseName(c.name)) continue;
    if (/Window/i.test(c.kind)) titles.push(c.name);
    else if (/Tab|Section/i.test(c.kind)) tabs.push(c.name);
    else if (/Toggle/i.test(c.kind)) controls.push({ kind: "Toggle", name: c.name });
    else if (/Slider/i.test(c.kind)) controls.push({ kind: "Slider", name: c.name });
    else if (/Dropdown/i.test(c.kind)) controls.push({ kind: "Dropdown", name: c.name });
    else if (/Input|TextBox/i.test(c.kind)) controls.push({ kind: "Input", name: c.name });
    else if (/Button|ImageButton/i.test(c.kind)) controls.push({ kind: "Button", name: c.name });
    else if (/Keybind/i.test(c.kind)) controls.push({ kind: "Keybind", name: c.name });
    else if (c.kind === "label" || c.kind === "Name") titles.push(c.name);
  }

  TAB_WORDS.lastIndex = 0;
  let tm;
  const tabBlob = strings.join("\n");
  while ((tm = TAB_WORDS.exec(tabBlob))) tabs.push(tm[1]);

  for (const s of strings) {
    if (isNoiseName(s) || s.includes("\n")) continue;
    FLAG_RE.lastIndex = 0;
    let m;
    while ((m = FLAG_RE.exec(s))) flags.add(m[1]);
    if (/^(Tab|Combat|Visuals|Misc|Main|Settings|Player|Farm|Rage|Legit|World)$/i.test(s.trim())) tabs.push(s.trim());
  }

  for (const f of flags) {
    if (!controls.some((c) => c.name.toLowerCase() === f.toLowerCase())) {
      const kind = /speed|fov|smooth|size|range/i.test(f) ? "Slider" : /mode|select/i.test(f) ? "Dropdown" : "Toggle";
      controls.push({ kind, name: f });
    }
  }

  const windowName = unique(titles, 8)[0] || `${lib.name} Hub`;
  const tabNames = unique(tabs.length ? tabs : ["Main", "Misc", "Settings"], 8);
  const ctrls = unique(
    controls.map((c) => c.kind + "\0" + c.name),
    60,
  ).map((x) => {
    const [kind, name] = x.split("\0");
    return { kind, name };
  });

  const accent = colors[0] || [93, 186, 122];
  const bg = colors[1] || [18, 18, 20];

  const lines = [];
  lines.push("-- .logui executable UI clone");
  lines.push(`-- library: ${lib.name}`);
  lines.push("-- same look (tabs, labels, asset ids). callbacks are empty.");
  lines.push("");
  lines.push("local Players = game:GetService('Players')");
  lines.push("local TweenService = game:GetService('TweenService')");
  lines.push("local UserInputService = game:GetService('UserInputService')");
  lines.push("local player = Players.LocalPlayer or Players.PlayerAdded:Wait()");
  lines.push("local pg = player:WaitForChild('PlayerGui')");
  lines.push("pcall(function() local old = pg:FindFirstChild('MZ_LOGUI') if old then old:Destroy() end end)");
  lines.push("");
  lines.push("local UI = {");
  lines.push(`  library = ${luaString(lib.name)},`);
  lines.push(`  window = ${luaString(windowName)},`);
  lines.push("  tabs = {");
  for (const t of tabNames) lines.push(`    ${luaString(t)},`);
  lines.push("  },");
  lines.push("  assets = {");
  for (const a of assets) lines.push(`    'rbxassetid://${a}',`);
  lines.push("  },");
  lines.push("  controls = {");
  for (const c of ctrls) lines.push(`    { kind = ${luaString(c.kind)}, name = ${luaString(c.name)} },`);
  lines.push("  },");
  lines.push("}");
  lines.push("");

  if (lib.name === "Rayfield" || lib.name === "Fluent" || lib.name === "Orion" || lib.name === "Kavo") {
    lines.push("-- try original library first (empty callbacks)");
    lines.push("local function empty() end");
    if (lib.load) {
      lines.push("local libOk, Library = pcall(function()");
      lines.push(`  return loadstring(game:HttpGet(${luaString(lib.load)}))()`);
      lines.push("end)");
      lines.push("if libOk and Library then");
      if (lib.name === "Rayfield") {
        lines.push(`  local Window = Library:CreateWindow({ Name = ${luaString(windowName)}, LoadingTitle = ${luaString(windowName)}, LoadingSubtitle = 'logui clone' })`);
        tabNames.forEach((t, i) => {
          lines.push(`  local Tab_${i + 1} = Window:CreateTab(${luaString(t)}, ${assets[i] ? Number(assets[i]) : 4483362458})`);
        });
        ctrls.forEach((c, i) => {
          const tab = `Tab_${(i % tabNames.length) + 1}`;
          if (c.kind === "Toggle") lines.push(`  ${tab}:CreateToggle({ Name = ${luaString(c.name)}, CurrentValue = false, Callback = empty })`);
          else if (c.kind === "Slider") lines.push(`  ${tab}:CreateSlider({ Name = ${luaString(c.name)}, Range = {0, 100}, Increment = 1, CurrentValue = 0, Callback = empty })`);
          else if (c.kind === "Dropdown") lines.push(`  ${tab}:CreateDropdown({ Name = ${luaString(c.name)}, Options = {'A','B'}, CurrentOption = 'A', Callback = empty })`);
          else lines.push(`  ${tab}:CreateButton({ Name = ${luaString(c.name)}, Callback = empty })`);
        });
      } else if (lib.name === "Fluent") {
        lines.push(`  local Window = Library:CreateWindow({ Title = ${luaString(windowName)}, SubTitle = 'logui clone', TabWidth = 160 })`);
        tabNames.forEach((t, i) => {
          lines.push(`  local Tab_${i + 1} = Window:AddTab({ Title = ${luaString(t)}, Icon = 'home' })`);
        });
        ctrls.forEach((c, i) => {
          const tab = `Tab_${(i % tabNames.length) + 1}`;
          if (c.kind === "Toggle") lines.push(`  ${tab}:AddToggle('${c.name.replace(/[^A-Za-z0-9]/g, "") || "T" + i}', { Title = ${luaString(c.name)}, Default = false, Callback = empty })`);
          else if (c.kind === "Slider") lines.push(`  ${tab}:AddSlider('${c.name.replace(/[^A-Za-z0-9]/g, "") || "S" + i}', { Title = ${luaString(c.name)}, Min = 0, Max = 100, Default = 0, Callback = empty })`);
          else lines.push(`  ${tab}:AddButton({ Title = ${luaString(c.name)}, Callback = empty })`);
        });
      } else {
        lines.push(`  local Window = Library:MakeWindow({ Name = ${luaString(windowName)}, HidePremium = true })`);
        tabNames.forEach((t, i) => {
          lines.push(`  local Tab_${i + 1} = Window:MakeTab({ Name = ${luaString(t)} })`);
        });
        ctrls.forEach((c, i) => {
          const tab = `Tab_${(i % tabNames.length) + 1}`;
          lines.push(`  ${tab}:AddButton({ Name = ${luaString(c.name)}, Callback = empty })`);
        });
      }
      lines.push("  return UI");
      lines.push("end");
      lines.push("");
    }
  }

  lines.push("-- ScreenGui clone (always built, works in any executor)");
  lines.push("local gui = Instance.new('ScreenGui')");
  lines.push("gui.Name = 'MZ_LOGUI'");
  lines.push("gui.ResetOnSpawn = false");
  lines.push("gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling");
  lines.push("gui.IgnoreGuiInset = true");
  lines.push("gui.Parent = pg");
  lines.push("");
  lines.push("local window = Instance.new('Frame')");
  lines.push("window.Name = 'Window'");
  lines.push("window.Size = UDim2.fromOffset(560, 380)");
  lines.push("window.Position = UDim2.fromScale(0.5, 0.5)");
  lines.push("window.AnchorPoint = Vector2.new(0.5, 0.5)");
  lines.push(`window.BackgroundColor3 = Color3.fromRGB(${bg[0]}, ${bg[1]}, ${bg[2]})`);
  lines.push("window.BorderSizePixel = 0");
  lines.push("window.Parent = gui");
  lines.push("Instance.new('UICorner', window).CornerRadius = UDim.new(0, 12)");
  lines.push("local stroke = Instance.new('UIStroke')");
  lines.push(`stroke.Color = Color3.fromRGB(${accent[0]}, ${accent[1]}, ${accent[2]})`);
  lines.push("stroke.Thickness = 1.2");
  lines.push("stroke.Parent = window");
  lines.push("");
  lines.push("local titleBar = Instance.new('TextLabel')");
  lines.push("titleBar.Size = UDim2.new(1, -50, 0, 40)");
  lines.push("titleBar.Position = UDim2.fromOffset(16, 8)");
  lines.push("titleBar.BackgroundTransparency = 1");
  lines.push("titleBar.Font = Enum.Font.GothamBold");
  lines.push("titleBar.TextSize = 18");
  lines.push("titleBar.TextXAlignment = Enum.TextXAlignment.Left");
  lines.push("titleBar.TextColor3 = Color3.fromRGB(236, 236, 228)");
  lines.push(`titleBar.Text = ${luaString(windowName)}`);
  lines.push("titleBar.Parent = window");
  lines.push("");
  if (assets[0]) {
    lines.push("local logo = Instance.new('ImageLabel')");
    lines.push("logo.Size = UDim2.fromOffset(28, 28)");
    lines.push("logo.Position = UDim2.new(1, -44, 0, 12)");
    lines.push("logo.BackgroundTransparency = 1");
    lines.push(`logo.Image = 'rbxassetid://${assets[0]}'`);
    lines.push("logo.Parent = window");
    lines.push("");
  }
  lines.push("local tabBar = Instance.new('Frame')");
  lines.push("tabBar.Size = UDim2.new(0, 140, 1, -56)");
  lines.push("tabBar.Position = UDim2.fromOffset(10, 48)");
  lines.push("tabBar.BackgroundColor3 = Color3.fromRGB(28, 28, 32)");
  lines.push("tabBar.BorderSizePixel = 0");
  lines.push("tabBar.Parent = window");
  lines.push("Instance.new('UICorner', tabBar).CornerRadius = UDim.new(0, 8)");
  lines.push("local tabList = Instance.new('UIListLayout', tabBar)");
  lines.push("tabList.Padding = UDim.new(0, 6)");
  lines.push("tabList.SortOrder = Enum.SortOrder.LayoutOrder");
  lines.push("local tabPad = Instance.new('UIPadding', tabBar)");
  lines.push("tabPad.PaddingTop = UDim.new(0, 8)");
  lines.push("tabPad.PaddingLeft = UDim.new(0, 8)");
  lines.push("tabPad.PaddingRight = UDim.new(0, 8)");
  lines.push("");
  lines.push("local pages = Instance.new('Frame')");
  lines.push("pages.Size = UDim2.new(1, -168, 1, -64)");
  lines.push("pages.Position = UDim2.fromOffset(158, 52)");
  lines.push("pages.BackgroundTransparency = 1");
  lines.push("pages.Parent = window");
  lines.push("");
  lines.push("local pageFrames = {}");
  lines.push("local function showPage(name)");
  lines.push("  for n, f in pairs(pageFrames) do f.Visible = (n == name) end");
  lines.push("end");
  lines.push("");

  tabNames.forEach((t, i) => {
    lines.push(`do local tabName = ${luaString(t)}`);
    lines.push("  local btn = Instance.new('TextButton')");
    lines.push("  btn.Size = UDim2.new(1, 0, 0, 32)");
    lines.push("  btn.BackgroundColor3 = Color3.fromRGB(40, 42, 38)");
    lines.push("  btn.BorderSizePixel = 0");
    lines.push("  btn.Font = Enum.Font.Gotham");
    lines.push("  btn.TextSize = 14");
    lines.push("  btn.TextColor3 = Color3.fromRGB(236, 236, 228)");
    lines.push("  btn.Text = tabName");
    lines.push("  btn.AutoButtonColor = true");
    lines.push("  btn.Parent = tabBar");
    lines.push("  Instance.new('UICorner', btn).CornerRadius = UDim.new(0, 6)");
    if (assets[i + 1]) {
      lines.push("  local ic = Instance.new('ImageLabel')");
      lines.push("  ic.Size = UDim2.fromOffset(16, 16)");
      lines.push("  ic.Position = UDim2.fromOffset(8, 8)");
      lines.push("  ic.BackgroundTransparency = 1");
      lines.push(`  ic.Image = 'rbxassetid://${assets[i + 1]}'`);
      lines.push("  ic.Parent = btn");
    }
    lines.push("  local page = Instance.new('ScrollingFrame')");
    lines.push("  page.Size = UDim2.fromScale(1, 1)");
    lines.push("  page.BackgroundTransparency = 1");
    lines.push("  page.BorderSizePixel = 0");
    lines.push("  page.ScrollBarThickness = 4");
    lines.push("  page.CanvasSize = UDim2.fromOffset(0, 0)");
    lines.push("  page.AutomaticCanvasSize = Enum.AutomaticSize.Y");
    lines.push("  page.Visible = false");
    lines.push("  page.Parent = pages");
    lines.push("  local lay = Instance.new('UIListLayout', page)");
    lines.push("  lay.Padding = UDim.new(0, 8)");
    lines.push("  pageFrames[tabName] = page");
    lines.push("  btn.MouseButton1Click:Connect(function() showPage(tabName) end)");
    lines.push("end");
    lines.push("");
  });

  ctrls.forEach((c, i) => {
    const tab = tabNames[i % tabNames.length];
    lines.push(`do local parent = pageFrames[${luaString(tab)}]`);
    lines.push("  local row = Instance.new('TextButton')");
    lines.push("  row.Size = UDim2.new(1, -8, 0, 36)");
    lines.push("  row.BackgroundColor3 = Color3.fromRGB(36, 36, 40)");
    lines.push("  row.BorderSizePixel = 0");
    lines.push("  row.AutoButtonColor = true");
    lines.push("  row.Font = Enum.Font.Gotham");
    lines.push("  row.TextSize = 14");
    lines.push("  row.TextXAlignment = Enum.TextXAlignment.Left");
    lines.push("  row.TextColor3 = Color3.fromRGB(220, 220, 214)");
    lines.push(`  row.Text = '  ' .. ${luaString(c.kind)} .. '  ·  ' .. ${luaString(c.name)}`);
    lines.push("  row.Parent = parent");
    lines.push("  Instance.new('UICorner', row).CornerRadius = UDim.new(0, 6)");
    lines.push("  row.MouseButton1Click:Connect(function() end)");
    if (assets[0] && c.kind === "Button") {
      lines.push("  local pic = Instance.new('ImageLabel')");
      lines.push("  pic.Size = UDim2.fromOffset(18, 18)");
      lines.push("  pic.Position = UDim2.new(1, -28, 0.5, -9)");
      lines.push("  pic.BackgroundTransparency = 1");
      lines.push(`  pic.Image = 'rbxassetid://${assets[i % assets.length]}'`);
      lines.push("  pic.Parent = row");
    }
    lines.push("end");
    lines.push("");
  });

  if (!ctrls.length) {
    lines.push("do local parent = pageFrames[UI.tabs[1]]");
    lines.push("  local row = Instance.new('TextLabel')");
    lines.push("  row.Size = UDim2.new(1, -8, 0, 36)");
    lines.push("  row.BackgroundTransparency = 1");
    lines.push("  row.Font = Enum.Font.Gotham");
    lines.push("  row.TextSize = 14");
    lines.push("  row.TextColor3 = Color3.fromRGB(160, 160, 150)");
    lines.push("  row.Text = 'No named controls recovered — window/tabs still clone the layout'");
    lines.push("  row.Parent = parent");
    lines.push("end");
    lines.push("");
  }

  lines.push(`showPage(${luaString(tabNames[0])})`);
  lines.push("");
  lines.push("-- drag");
  lines.push("do");
  lines.push("  local dragging, start, startPos");
  lines.push("  titleBar.InputBegan:Connect(function(input)");
  lines.push("    if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then");
  lines.push("      dragging = true");
  lines.push("      start = input.Position");
  lines.push("      startPos = window.Position");
  lines.push("      input.Changed:Connect(function()");
  lines.push("        if input.UserInputState == Enum.UserInputState.End then dragging = false end");
  lines.push("      end)");
  lines.push("    end");
  lines.push("  end)");
  lines.push("  UserInputService.InputChanged:Connect(function(input)");
  lines.push("    if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then");
  lines.push("      local d = input.Position - start");
  lines.push("      window.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + d.X, startPos.Y.Scale, startPos.Y.Offset + d.Y)");
  lines.push("    end");
  lines.push("  end)");
  lines.push("end");
  lines.push("");
  lines.push("return UI");
  return stampSource(lines.join("\n"), ["command: .logui", `library: ${lib.name}`, "executable UI clone"]);
}
