// Golden Hour interface language (English / 简体中文).
//
// The game builds its interface in English. This layer watches the page and swaps each piece of
// interface text for its translation, remembering the English so switching back restores it
// exactly. It never edits the game code, so it keeps working when the game is updated; text it
// does not know simply stays in English. Proper names (weapon models, attachment brands, operator
// names) and key caps stay as they are.
(() => {
    const ZH = {
        // Main menu and frame
        'DEPLOY': '出击',
        'GUNSMITH': '枪匠',
        'ATTACHMENTS': '配件',
        'CAMOS': '迷彩',
        'DIFFICULTY': '难度',
        'SETTINGS': '设置',
        'CONTROLS': '操作',
        'MOUSE & VIEW': '鼠标与视角',
        'AUDIO': '音频',
        'GRAPHICS': '画面',
        'INTERFACE': '界面',
        'LOADOUT': '配装',
        'FACTORY CONFIGURATION': '出厂配置',
        'FIELD UPGRADE —': '战场升级 —',
        'FIELD UPGRADE': '战场升级',
        'K9 UNIT': 'K9 军犬',
        'K9 unit': 'K9 军犬',
        'NAVIGATE': '导航',
        'SELECT': '选择',
        'CHANGE': '切换',
        'ADJUST': '调整',
        'BACK': '返回',
        'OPTION': '选项',
        'EQUIP': '装备',
        'SLOT': '槽位',
        'RESET': '重置',
        'SET PRIMARY': '设为主武器',
        'RESUME': '继续',
        'QUIT TO MENU': '退出到主菜单',
        'PAUSED': '已暂停',
        'APPLIES ON NEXT SPAWN': '下次重生时生效',
        'REMAINING': '剩余',
        'FIRST TO 40': '先达 40 分',
        'FIRST TO': '先达',
        'FIRST TO 40 ELIMINATIONS': '先达 40 次击杀',
        'TEAM DEATHMATCH': '团队死斗',
        'SOLSTICE HOTEL': '至日酒店',
        'SKY LOBBY': '空中大堂',
        'GOLDEN HOUR — Solstice Hotel': '黄金时刻 — 至日酒店',
        'OPERATOR': '干员',
        'MATCHES': '场次',
        'WINS': '胜场',
        'WIN RATE': '胜率',
        'ELIMS': '击杀',
        'WEAPON MASTERY': '武器精通',
        'RANK': '等级',
        'NEXT': '下一个',
        'VANGUARD': '先锋',
        'EMBER': '余烬',
        'You': '你',
        'YOU': '你',
        'Gravity': '重力',

        // Difficulty and ranks
        'RECRUIT': '新兵',
        'REGULAR': '普通',
        'HARDENED': '老练',
        'VETERAN': '老兵',
        'SPECIALIST': '专家',
        'SERGEANT': '中士',
        'LIEUTENANT': '中尉',
        'CAPTAIN': '上尉',
        'MAJOR': '少校',
        'COLONEL': '上校',
        'COMMANDER': '指挥官',
        'LEGEND': '传奇',
        'RANK UP': '晋升',

        // Weapons
        'KR-7 CARBINE': 'KR-7 卡宾枪',
        'M12 BREACHER': 'M12 破门者',
        'ASSAULT RIFLE': '突击步枪',
        'SUBMACHINE GUN': '冲锋枪',
        'SHOTGUN': '霰弹枪',
        'PISTOL': '手枪',
        'PRIMARY': '主武器',
        'SECONDARY': '副武器',
        'WEAPON': '武器',
        'WEAPONS': '武器',
        'Balanced carbine. Wins the long lanes of the atrium.': '均衡的卡宾枪，中庭长廊对枪的首选。',
        'Fast-handling 9 mm. Owns corridors and the bar.': '操控灵活的 9 毫米冲锋枪，走廊和酒吧的主宰。',
        'Pump-action 12 gauge. One trigger pull inside a room.': '泵动式 12 号霰弹枪，室内一枪解决。',
        'Striker-fired sidearm. Always on your hip.': '击针式副武器，随时在腰间待命。',
        'PUMP': '泵动',
        'AUTO': '全自动',
        'SEMI': '半自动',
        'SUPPRESSED': '已消音',
        'LASER': '激光',

        // Weapon stats
        'DAMAGE': '伤害',
        'RANGE': '射程',
        'FIRE RATE': '射速',
        'ACCURACY': '精准度',
        'RECOIL CONTROL': '后坐力控制',
        'MOBILITY': '机动性',
        'HANDLING': '操控性',
        'VERTICAL RECOIL': '垂直后坐力',
        'HORIZONTAL RECOIL': '水平后坐力',
        'ADS TIME': '开镜时间',
        'SPRINT-TO-FIRE': '冲刺转射击时间',
        'MOVE SPEED': '移动速度',
        'ADS MOVE SPEED': '开镜移动速度',
        'ZOOM': '放大倍率',
        'HIP SPREAD': '腰射散布',
        'RELOAD TIME': '换弹时间',
        'MAG SIZE': '弹匣容量',
        'MUZZLE FLASH': '枪口焰',
        'NO STAT CHANGE': '无属性变化',
        'RPM': '发/分',
        'MS': '毫秒',
        'MAG': '弹匣',
        'ADS': '开镜',
        'SPRINT': '冲刺',

        // Attachment slots and attachments
        'OPTIC': '瞄具',
        'MUZZLE': '枪口',
        'UNDERBARREL': '下挂',
        'MAGAZINE': '弹匣',
        'STOCK': '枪托',
        'IRON SIGHTS': '机械瞄具',
        'Nothing between you and the target. Fastest to the eye.': '与目标之间毫无遮挡，开镜最快。',
        'KITE REFLEX': 'KITE 反射瞄具',
        'Open red dot. Precise and quick.': '开放式红点，精准又快速。',
        'HALO HOLOGRAPHIC': 'HALO 全息瞄具',
        'Wide window with a ring-and-dot reticle.': '宽视野窗口，环形加点分划。',
        'Magnified prism sight for the long lanes.': '用于长廊的棱镜放大瞄具。',
        'FACTORY MUZZLE': '原厂枪口',
        'Standard flash hider.': '标准消焰器。',
        'MONOLITH SUPPRESSOR': 'MONOLITH 消音器',
        'Quiet report and a hidden flash. Enemies hear you late.': '枪声更小、枪口焰隐蔽，敌人更晚察觉你。',
        'PORTED COMPENSATOR': '开孔补偿器',
        'Vents gas upward to hold the muzzle down.': '向上排气，压住枪口上跳。',
        'SLOTTED BRAKE': '开槽制退器',
        'Kills side-to-side drift.': '消除左右漂移。',
        'FULL CHOKE': '全收束',
        'Tighter pattern, longer reach.': '弹着更集中，射程更远。',
        'NO UNDERBARREL': '无下挂',
        'Bare handguard.': '光护木。',
        'VERTICAL FOREGRIP': '垂直握把',
        'A firm hold that steadies sustained fire.': '握持稳固，持续射击更稳定。',
        'ANGLED FOREGRIP': '斜角握把',
        'Snappier to the shoulder and out of a sprint.': '抵肩和冲刺后出枪更迅速。',
        'TAC LASER': '战术激光',
        'Visible beam. Tightens hip fire.': '可见光束，收紧腰射散布。',
        'STANDARD MAG': '标准弹匣',
        'Factory capacity.': '出厂容量。',
        'EXTENDED MAG': '扩容弹匣',
        'SPEED MAG': '快速弹匣',
        'Flared well and a pull tab for faster changes.': '扩口弹匣井加拉环，换弹更快。',
        'FACTORY STOCK': '原厂枪托',
        'SKELETON STOCK': '镂空枪托',
        'PADDED STOCK': '加垫枪托',
        'Soaks up recoil at the cost of speed.': '以速度为代价吸收后坐力。',

        // Gunsmith
        'FITTED': '已安装',
        'APPLIED': '已应用',
        'SET AS PRIMARY': '设为主武器',
        'CONFIRM RESET': '确认重置',
        'RESET BUILD': '重置改装',
        'CHANGES APPLY ON YOUR NEXT SPAWN': '改动将在下次重生时生效',
        'AVAILABLE FROM THE START': '初始可用',
        'LOCKED': '未解锁',
        'UNLOCKED': '已解锁',
        'EQUIPPED': '已装备',
        'EQUIPPED AS PRIMARY': '已设为主武器',
        'TIER': '阶级',
        'HEADSHOTS': '爆头',
        'K9 TAKEDOWNS': 'K9 击杀',
        'CHALLENGE COMPLETE': '挑战完成',
        'CAMO UNLOCKED': '迷彩已解锁',
        'CAMO PROGRESS': '迷彩进度',
        'ALL CAMOS UNLOCKED': '全部迷彩已解锁',
        'WEAPON CAMOS': '武器迷彩',
        'STANDARD ISSUE': '标准配发',
        'MILITARY': '军用',
        'SPECIAL': '特殊',
        'MASTERY': '精通',
        'COMPLETIONIST': '全收集',
        'COMPLETION': '完成度',

        // Camos
        'FACTORY': '原厂',
        'As issued.': '出厂原样。',
        'DUNE': '沙丘',
        'Flat dark earth with worn edges.': '暗土色，边缘磨损。',
        'TIMBERLINE': '林线',
        'Hand-sprayed woodland through netting.': '透过网格手工喷涂的林地迷彩。',
        'FRACTURE': '碎裂',
        'Urban shards in three greys.': '三种灰色的城市碎片迷彩。',
        'TIGERSTRIPE': '虎纹',
        'Black brushstrokes over olive and tan.': '橄榄绿与棕褐底色上的黑色笔触。',
        'EMBER TOPO': '余烬等高线',
        'Burnt-orange contour lines on matte black.': '哑光黑底上的焦橙色等高线。',
        'CARBON WEAVE': '碳纤维编织',
        'Twill-weave carbon under clear coat.': '透明涂层下的斜纹碳纤维。',
        'DAMASCUS': '大马士革',
        'Folded-steel waves, acid etched.': '酸蚀的折叠钢波纹。',
        'SOLSTICE GOLD': '至日金',
        'Polished gold with engraved scrollwork.': '抛光黄金，饰以雕刻卷纹。',
        'MOLTEN OBSIDIAN': '熔岩黑曜石',
        'Black glass with a slow ember glow in the cracks.': '裂缝中透出余烬微光的黑色玻璃。',

        // Controls
        'MOVEMENT': '移动',
        'MOVE': '移动',
        'SPRINT — ANY DIRECTION': '冲刺 — 任意方向',
        'JUMP / MANTLE': '跳跃 / 攀爬',
        'CROUCH / SLIDE': '蹲下 / 滑铲',
        'PRONE / DIVE': '卧倒 / 飞扑',
        'COMBAT': '战斗',
        'FIRE': '开火',
        'AIM DOWN SIGHTS': '开镜瞄准',
        'RELOAD': '换弹',
        'MELEE': '近战',
        'FRAG GRENADE': '破片手雷',
        'UNLEASH K9 UNIT': '放出 K9 军犬',
        'SWAP WEAPON': '切换武器',
        'INSPECT WEAPON': '检视武器',
        'GENERAL': '通用',
        'PAUSE / BACK': '暂停 / 返回',
        'SCOREBOARD': '计分板',
        'MENU NAVIGATE': '菜单导航',
        'MENU SELECT': '菜单确认',
        'SWITCH TAB': '切换标签',
        'OR': '或',

        // Mouse & view
        'MOUSE SENSITIVITY': '鼠标灵敏度',
        'How far the view turns for a given mouse movement. Lower is steadier for rifles; higher turns faster in close quarters.':
            '鼠标移动同样距离时视角转动的幅度。调低更适合步枪稳定瞄准，调高在近距离转身更快。',
        'ADS SENSITIVITY MULTIPLIER': '开镜灵敏度倍率',
        'Applied on top of sensitivity while aiming down sights. Zoom already slows the view; 1.00 keeps the same hand distance per on-screen distance.':
            '开镜瞄准时在灵敏度基础上额外乘以此倍率。放大本身已会让视角变慢；1.00 表示屏幕上移动同样距离所需的手部移动不变。',
        'INVERT VERTICAL LOOK': '反转垂直视角',
        'Pushing the mouse forward looks down instead of up.': '向前推鼠标时视角向下而不是向上。',
        'FIELD OF VIEW': '视野范围',
        'Horizontal field of view at 16:9. Wider shows more of the room and makes movement feel faster; narrower makes distant targets larger.':
            '16:9 下的水平视野。更宽能看到更多房间、移动感更快；更窄会让远处目标显得更大。',
        'OFF': '关',
        'ON': '开',

        // Audio
        'MASTER VOLUME': '主音量',
        'Overall loudness of everything: weapons, footsteps, interface and music.': '所有声音的总音量：武器、脚步、界面和音乐。',
        'EFFECTS VOLUME': '音效音量',
        'Weapons, impacts, footsteps and ambience, relative to the master volume.': '武器、命中、脚步和环境声，按主音量的比例调整。',
        'MUSIC VOLUME': '音乐音量',
        'Menu score and the lounge band playing in the Ember Bar. Shooting the speaker also works.':
            '菜单配乐和余烬酒吧里乐队的演奏。射击音箱也能让它停下。',

        // Graphics
        'QUALITY PRESET': '画质预设',
        'One switch for resolution scale, anti-aliasing, shadows, ambient occlusion, reflections and light shafts.':
            '一键调整分辨率比例、抗锯齿、阴影、环境光遮蔽、反射和光束。',
        'LOW': '低',
        'MEDIUM': '中',
        'HIGH': '高',
        'low': '低',
        'medium': '中',
        'high': '高',
        '70% resolution, no anti-aliasing, no ambient occlusion or floor reflections. For integrated graphics.':
            '70% 分辨率，无抗锯齿，无环境光遮蔽和地面反射。适合集成显卡。',
        '85% resolution, 2× MSAA, half-rate floor reflections and light shafts.': '85% 分辨率，2× MSAA，半速率地面反射和光束。',
        'Full resolution, 4× MSAA, ambient occlusion and 4K sun shadows. Recommended.': '全分辨率，4× MSAA，环境光遮蔽和 4K 日光阴影。推荐。',
        'MOTION BLUR': '动态模糊',
        'Film-style blur on fast camera turns and on the weapon and hands as they move (reload, recoil, swap). The weapon stays sharp at rest. Off is the competitive choice.':
            '镜头快速转动以及武器和双手移动（换弹、后坐、切枪）时的电影式模糊。武器静止时保持清晰。竞技玩家建议关闭。',
        'FULLSCREEN': '全屏',
        'Borderless fullscreen. F11 does the same; Esc leaves it.': '无边框全屏。按 F11 效果相同，按 Esc 退出。',

        // Interface
        'MINIMAP': '小地图',
        'ROTATING': '跟随旋转',
        'NORTH UP': '北向朝上',
        'Rotating keeps your view pointing up, like the compass. North Up keeps the hotel still and turns your arrow instead.':
            '跟随旋转让你的朝向始终向上，就像指南针；北向朝上则固定酒店方向，改为转动你的箭头。',
        'CROSSHAIR COLOUR': '准星颜色',
        'WHITE': '白',
        'CYAN': '青',
        'LIME': '绿',
        'AMBER': '琥珀',
        'Pick the colour you lose least against the sunset. The crosshair always turns red over an enemy.':
            '选一个在夕阳背景下最不容易看丢的颜色。准星对准敌人时总会变红。',
        'HUD SCALE': '界面缩放',
        'Size of the in-match HUD. Menus are not affected.': '对局内界面的大小，不影响菜单。',
        'CONTROL HINTS': '操作提示',
        'Shows the movement keys at the start of your first few matches.': '在最初几局开始时显示移动按键。',

        // Match HUD and callouts
        'RELOADING': '换弹中',
        'NO AMMO': '弹药耗尽',
        'LOW AMMO': '弹药不足',
        'MATCH POINT': '赛点',
        'NEED ONE ELIMINATION': '还差一次击杀',
        '30 SECONDS': '剩余 30 秒',
        'FINAL KILL': '最终击杀',
        'TIME LIMIT REACHED': '时间到',
        'ONE MINUTE REMAINING': '剩余 1 分钟',
        'LEAD TAKEN': '取得领先',
        'LEAD LOST': '失去领先',
        'SCORES TIED': '比分持平',
        'MATCH START': '比赛开始',
        'VICTORY': '胜利',
        'DEFEAT': '失败',
        'DRAW': '平局',
        'SPRINT ANY DIRECTION': '任意方向冲刺',
        'SLIDE': '滑铲',
        'DIVE': '飞扑',
        'SCORES': '计分板',
        // The legend's "Q E TAB"; key caps themselves stay as printed.
        'TAB': '切换标签',
        'WIN': '胜利',
        'ELIMINATED BY': '击杀者',
        'OUT OF BOUNDS': '出界',
        'SELF-INFLICTED': '自杀',
        'DESTROYED': '已摧毁',
        'ELIMINATED': '已淘汰',
        'RESPAWN IN': '重生倒计时',
        'ENEMY K9 CLOSE': '敌方 K9 接近',
        'K9 UNIT ALREADY HUNTING': 'K9 军犬正在猎杀',
        'K9 UNLEASHED': 'K9 军犬已放出',
        'HUNTING HOSTILES': '正在猎杀敌人',
        'K9 UNIT DESTROYED': 'K9 军犬已被摧毁',
        'K9 BATTERY DEPLETED': 'K9 电量耗尽',
        'K9 UNIT READY': 'K9 军犬就绪',
        'K9 UNIT CHARGING': 'K9 军犬充能中',
        'ENEMY K9 DESTROYED': '敌方 K9 已摧毁',
        'BY YOU': '由你',
        'BY': '由',
        'FALL': '坠落',
        'CHANDELIER': '吊灯',

        // Medals
        'K9 TAKEDOWN': 'K9 击杀',
        'PACK LEADER': '头狼',
        'K9 DESTROYED': '摧毁 K9',
        'HEADSHOT': '爆头',
        'DOUBLE KILL': '双杀',
        'TRIPLE KILL': '三杀',
        'FURY KILL': '狂怒击杀',
        'FRENZY KILL': '狂乱击杀',
        'SLIDE KILL': '滑铲击杀',
        'DIVE KILL': '飞扑击杀',
        'AIRBORNE': '空中击杀',
        'KNOCKOUT': '近战击倒',
        'FRAGGED': '炸杀',
        'LONGSHOT': '远距击杀',
        'POINT BLANK': '贴脸击杀',
        'SURVIVOR': '幸存者',
        'BLOODTHIRSTY': '嗜血',
        'MERCILESS': '无情',

        // Map areas
        'ATRIUM LOBBY': '中庭大堂',
        'EMBER BAR': '余烬酒吧',
        'RESTAURANT': '餐厅',
        'SERVICE CORRIDOR': '服务通道',
        'KITCHEN': '厨房',
        'EAST CORRIDOR': '东侧走廊',
        'CONFERENCE': '会议厅',
        'SUITE': '套房',
        'POOL': '泳池',
        'TERRACE': '露台',

        // End of match
        'PROGRESSION': '成长',
        'TOTAL XP': '总经验',
        'XP': '经验',
        'YOUR PERFORMANCE': '你的表现',
        'DEATHS': '死亡',
        'K/D RATIO': '击杀/死亡比',
        'BEST STREAK': '最高连杀',
        'SHOTS FIRED': '开火次数',
        'MEDALS': '勋章',
        'NO MEDALS THIS MATCH': '本局没有获得勋章',
        'MATCH MVP': '本局 MVP',
        'PLAY AGAIN': '再来一局',
        'MAIN MENU': '主菜单',
        'SCORE': '得分',
        'CHOOSE': '选择',
        'ELIMINATIONS': '击杀',

        // Loading
        'INITIALISING RENDERER': '正在初始化渲染器',
        'PAINTING MATERIALS': '正在绘制材质',
        'BUILDING FURNITURE': '正在搭建家具',
        'RAISING THE HOTEL': '正在建造酒店',
        'DRESSING THE LOBBY': '正在布置大堂',
        'DETAILING': '正在刻画细节',
        'CAPTURING LIGHT': '正在捕捉光照',
        'MAPPING ROUTES': '正在规划路线',
        'ASSEMBLING WEAPONS': '正在组装武器',
        'PREPARING THE ARMOURY': '正在准备军械库',
        'BRIEFING OPERATORS': '正在简报干员',
        'FINAL CHECKS': '最终检查',
        'READY': '就绪',
        'PREPARING': '准备中',
        'FIELD NOTES': '战术提示',
        'Bullets punch through thin cover. Wooden slats, plaster and furniture will not save anyone.':
            '子弹能穿透薄掩体，木板、石膏墙和家具都挡不住。',
        'The atrium chandelier is not decoration. Shoot the mount when somebody stands underneath.':
            '中庭的吊灯可不是摆设。有人站在下面时，射击它的吊架。',
        'Health regenerates after a few seconds out of the fight. Break line of sight, then re-engage.':
            '脱离战斗几秒后生命值会自动恢复。先脱离视线，再重新交战。',
        'The balcony ring sees the whole lobby. So does everyone looking up at it.':
            '环形阳台能俯瞰整个大堂，抬头看它的人也一样能看到你。'
    };

    // Tips that mix plain text with bold words are translated as whole blocks, so the Chinese
    // keeps its own word order around the highlighted words.
    const ZH_BLOCKS = {
        'Sprint works in <b>every direction</b>. Strafe-sprint out of a bad angle instead of turning your back.':
            '冲刺可以朝<b>任意方向</b>进行。用侧向冲刺脱离不利角度，别把后背留给敌人。',
        'Slide with <b>C</b> while sprinting to take a corner low and fast. Slide kills earn a medal.':
            '冲刺时按 <b>C</b> 滑铲，压低身位快速过弯。滑铲击杀可获得勋章。',
        'Dive with <b>X</b> through a window: every pane in the hotel breaks.':
            '按 <b>X</b> 飞扑穿过窗户：酒店里的每一块玻璃都能撞碎。',
        'Enemies appear on your minimap when they <b>fire</b>. A suppressor keeps bots from hearing you early.':
            '敌人<b>开火</b>时会出现在小地图上。装上消音器，机器人就不会过早听到你。',
        'Headshots unlock the Tigerstripe and Ember Topo camos. Build each weapon in the <b>Gunsmith</b>.':
            '爆头可解锁虎纹和余烬等高线迷彩。在<b>枪匠</b>中打造每一把武器。',
        'Empty magazine? Swapping to your sidearm with <b>2</b> is always faster than reloading.':
            '弹匣打空了？按 <b>2</b> 切换副武器永远比换弹快。',
        'Your <b>K9 unit</b> charges while you fight. Press <b>B</b> to unleash it: it hunts on its own until its battery runs out.':
            '你的 <b>K9 军犬</b>会在战斗中充能。按 <b>B</b> 放出它：它会自主猎杀，直到电量耗尽。',
        'An <b>enemy K9</b> can be shot down. Watch the red edge marker, turn toward it and fire before it leaps.':
            '<b>敌方 K9</b> 可以被击落。留意屏幕边缘的红色标记，转向它并在它扑过来之前开火。'
    };

    const number = '[+\\-−]?[\\d,.]+';
    const PATTERNS = [
        [/^([+\-−])([\d.]+)% (.+)$/, (m, word) => word(m[3]) && `${m[1]}${m[2]}% ${word(m[3])}`],
        [/^([\d,]+) \/ ([\d,]+) (.+)$/, (m, word) => word(m[3]) && `${m[1]} / ${m[2]} ${word(m[3])}`],
        [/^RANK (\d+)$/, (m) => `等级 ${m[1]}`],
        [/^FRAG × (\d+)$/, (m) => `破片手雷 × ${m[1]}`],
        [/^(\d+) v (\d+)$/, (m) => `${m[1]} 对 ${m[2]}`],
        [/^(\d+:\d\d) REMAINING$/, (m) => `剩余 ${m[1]}`],
        [/^(.+) NEED ONE ELIMINATION$/, (m, word) => word(m[1]) && `${word(m[1])} 还差一次击杀`],
        [/^(.+) WIN (\d+)$/, (m, word) => word(m[1]) && `${word(m[1])} 获胜 ${m[2]}`],
        [/^Charges in (\d+) s · hunts on its own for (\d+) s$/, (m) => `${m[1]} 秒充能 · 自主猎杀 ${m[2]} 秒`],
        [/^Charges in (\d+) s · hunts for (\d+) s$/, (m) => `${m[1]} 秒充能 · 猎杀 ${m[2]} 秒`],
        [new RegExp(`^(${number}) (.+)$`), (m, word) => word(m[2]) && `${m[1]} ${word(m[2])}`],
        [new RegExp(`^(.+) (${number})$`), (m, word) => word(m[1]) && `${word(m[1])} ${m[2]}`]
    ];

    const exact = (text) => (Object.prototype.hasOwnProperty.call(ZH, text) ? ZH[text] : null);
    const word = (text) => exact(text) ?? pattern(text);
    function pattern(text) {
        for (const [regex, build] of PATTERNS) {
            const match = text.match(regex);
            if (match) {
                const result = build(match, exact);
                if (result) return result;
            }
        }
        return null;
    }
    // Labels joined with "·" or "—" ("OPERATOR · VANGUARD") translate part by part; parts that
    // are numbers or codes ("47F") pass through, but at least one part must be a real translation.
    function composite(text) {
        const parts = text.split(/(\s+[·—–]\s+)/);
        if (parts.length < 3) return null;
        let translated = 0;
        const out = parts.map((part, index) => {
            if (index % 2) return part;
            const result = word(part);
            if (result) translated++;
            else if (!/^[\d\w.,:%×+\-−/]*$/.test(part) || /[a-z]{2}/.test(part)) return null;
            return result ?? part;
        });
        return translated && !out.includes(null) ? out.join('') : null;
    }
    const translate = (text) => word(text) ?? composite(text);

    function toChinese(value) {
        const core = value.replace(/\s+/g, ' ').trim();
        if (!core || !/[A-Za-z]/.test(core)) return null;
        const result = translate(core);
        if (!result) return null;
        const lead = value.match(/^\s*/)[0];
        const tail = value.match(/\s*$/)[0];
        return lead + result + tail;
    }

    // ---- Live page translation -------------------------------------------------------------
    let language = 'en';
    const textState = new WeakMap(); // text node -> { source, shown }
    const attrState = new WeakMap(); // element -> { [attribute]: { source, shown } }
    const blockState = new WeakMap(); // element -> { source, shown }
    const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'];
    const SKIP = 'script,style,textarea,input,kbd,.gh-phone-notice,.gh-lang,[translate="no"]';
    const blocks = new Map(Object.entries(ZH_BLOCKS).map(([en, zh]) => [en.replace(/\s+/g, ' ').trim(), zh]));

    const skipped = (element) => !element || element.closest(SKIP);

    function applyText(node) {
        if (skipped(node.parentElement)) return;
        const value = node.nodeValue;
        let state = textState.get(node);
        if (!state || value !== state.shown) {
            state = { source: value, shown: value };
            textState.set(node, state);
        }
        const wanted = language === 'zh-CN' ? (toChinese(state.source) ?? state.source) : state.source;
        state.shown = wanted;
        if (wanted !== value) node.nodeValue = wanted;
    }

    function applyAttributes(element) {
        if (skipped(element)) return;
        for (const name of ATTRIBUTES) {
            if (!element.hasAttribute(name)) continue;
            const value = element.getAttribute(name);
            const all = attrState.get(element) || {};
            let state = all[name];
            if (!state || value !== state.shown) state = all[name] = { source: value, shown: value };
            attrState.set(element, all);
            const wanted = language === 'zh-CN' ? (toChinese(state.source) ?? state.source) : state.source;
            state.shown = wanted;
            if (wanted !== value) element.setAttribute(name, wanted);
        }
    }

    function applyBlock(element) {
        // Tip blocks hold a few words and one or two bold spans; never serialize big containers.
        if (!element.childElementCount || element.childElementCount > 4 || element.childNodes.length > 9 || skipped(element)) return false;
        const html = element.innerHTML;
        if (html.length > 600 || !html.includes('<b>')) return false;
        let state = blockState.get(element);
        if (!state || html !== state.shown) {
            const key = html.replace(/\s+/g, ' ').trim();
            if (!blocks.has(key)) return false;
            state = { source: html, key, shown: html };
            blockState.set(element, state);
        }
        const wanted = language === 'zh-CN' ? blocks.get(state.key) : state.source;
        state.shown = wanted;
        if (wanted !== html) element.innerHTML = wanted;
        return true;
    }

    function applyTree(root) {
        if (root.nodeType === 3) {
            applyText(root);
            return;
        }
        if (root.nodeType !== 1 || skipped(root)) return;
        if (applyBlock(root)) return;
        applyAttributes(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (node.nodeType === 1 && node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        });
        const elements = [];
        const texts = [];
        while (walker.nextNode()) (walker.currentNode.nodeType === 3 ? texts : elements).push(walker.currentNode);
        const inBlock = new Set();
        for (const element of elements) {
            if (inBlock.has(element.parentElement) || [...inBlock].some((block) => block.contains(element))) continue;
            if (applyBlock(element)) inBlock.add(element);
            else applyAttributes(element);
        }
        for (const text of texts) if (![...inBlock].some((block) => block.contains(text))) applyText(text);
    }

    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === 'characterData') {
                const parent = record.target.parentElement;
                if (parent && blockState.has(parent)) applyBlock(parent);
                else applyText(record.target);
            } else if (record.type === 'attributes') {
                applyAttributes(record.target);
            } else {
                if (record.target.nodeType === 1 && applyBlock(record.target)) continue;
                record.addedNodes.forEach(applyTree);
            }
        }
        injectSwitch();
    });

    // ---- Language switch on the settings page ------------------------------------------------
    // Inside the GavinOS window the desktop owns the language (its taskbar 中/EN button), so the
    // switch asks the desktop; opened on its own, the game saves the choice the way the site does.
    const embedded = window.parent !== window;
    const requestLanguage = (next) => {
        setLanguage(next);
        if (embedded) {
            window.parent.postMessage({ source: 'golden-hour', type: 'language', lang: language }, '*');
        } else {
            try { localStorage.setItem('portfolio-lang', language); } catch { /* The page still switches. */ }
        }
    };
    // It sits at the bottom right, across from the key legend: the header has no room left for it
    // in English at the size of the desktop window.
    function injectSwitch() {
        const page = document.querySelector('.tab[data-tab="controls"]')?.closest('header.topbar')?.parentElement;
        if (!page || page.querySelector(':scope > .gh-lang')) {
            syncSwitch();
            return;
        }
        const control = document.createElement('div');
        control.className = 'gh-lang';
        control.setAttribute('role', 'group');
        control.setAttribute('aria-label', '语言 / Language');
        control.innerHTML = '<span class="gh-lang-label">语言 / LANGUAGE</span>'
            + '<button type="button" data-lang="zh-CN">中文</button><button type="button" data-lang="en">EN</button>';
        control.addEventListener('click', (event) => {
            event.stopPropagation();
            const button = event.target.closest('button[data-lang]');
            if (button) requestLanguage(button.dataset.lang);
        });
        page.append(control);
        syncSwitch();
    }
    function syncSwitch() {
        document.querySelectorAll('.gh-lang button[data-lang]').forEach((button) => {
            const on = button.dataset.lang === language;
            button.classList.toggle('on', on);
            button.setAttribute('aria-pressed', String(on));
        });
    }

    function setLanguage(next) {
        next = next === 'en' ? 'en' : 'zh-CN';
        if (next === language && observing) return;
        language = next;
        document.documentElement.lang = next;
        document.documentElement.classList.toggle('gh-zh', next === 'zh-CN');
        if (document.body) applyTree(document.body);
        const title = document.querySelector('title');
        if (title) applyTree(title);
        syncSwitch();
    }

    let observing = false;
    function start() {
        if (observing || !document.body) return;
        observing = true;
        applyTree(document.body);
        const title = document.querySelector('title');
        if (title) applyTree(title);
        observer.observe(document.documentElement, {
            subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES
        });
        injectSwitch();
    }

    window.GoldenHourI18n = {
        get language() { return language; },
        setLanguage(next) {
            setLanguage(next);
            start();
        },
        translate: (text) => toChinese(text)
    };
    if (!embedded) {
        let saved = null;
        try { saved = localStorage.getItem('portfolio-lang'); } catch { /* Fall back to the site default. */ }
        language = saved === 'en' ? 'en' : 'zh-CN';
        document.documentElement.lang = language;
        document.documentElement.classList.toggle('gh-zh', language === 'zh-CN');
        window.addEventListener('storage', (event) => {
            if (event.key === 'portfolio-lang' && event.newValue) setLanguage(event.newValue);
        });
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
