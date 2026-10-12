//! The macOS menu bar: the standard roles plus File, whose items are relayed to the frontend as `MenuAction`s.

use tauri::menu::{MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager as _, Wry};
use tauri_specta::Event as _;

use crate::events::MenuAction;

const OPEN_FOLDER: &str = "folder.open";
const RECENT_PREFIX: &str = "recent:";

pub struct RecentMenu(Submenu<Wry>);

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let recent = SubmenuBuilder::new(app, "Open Recent").enabled(false).build()?;
    let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id(OPEN_FOLDER, "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&recent)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&app_menu, &file, &edit, &view, &window])
            .build()?,
    )?;
    app.manage(RecentMenu(recent));
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        let action = match id.strip_prefix(RECENT_PREFIX) {
            Some(path) => MenuAction::OpenFolder { path: path.to_owned() },
            None if id == OPEN_FOLDER => MenuAction::Command { id: id.to_owned() },
            None => return,
        };
        let _ = action.emit(app);
    });
    Ok(())
}

pub fn set_recent(app: &AppHandle, paths: &[String]) -> tauri::Result<()> {
    let menu = &app.state::<RecentMenu>().0;
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    for path in paths {
        let mut tail: Vec<&str> = path.rsplit('/').take(2).collect();
        tail.reverse();
        let label = tail.join("/");
        menu.append(&MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{path}"), label).build(app)?)?;
    }
    menu.set_enabled(!paths.is_empty())
}
